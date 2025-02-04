const config = require("./config");
const path = require("path");
const http = require("http");
const mqtt = require('mqtt');
const { promises: fs } = require("fs");
const fsExtra = require("fs-extra");
const puppeteer = require("puppeteer");
const { CronJob } = require("cron");
const gm = require("gm");

// Overwriting
console.logReal = console.log;
console.errorReal = console.error;
console.log = function () {
  var args = [].slice.call(arguments);
  console.logReal.apply(console.log,['[' + (new Date()).toLocaleString() + ']'].concat(args));
};
console.error = function () {
  var args = [].slice.call(arguments);
  console.errorReal.apply(console.error,['[' + (new Date()).toLocaleString() + ']'].concat(args));
};

// keep state of current state for devcies
const stateStore = {};
const pageCacheTimes= {};

let browser; // Declare browser globally

var mqttClient = {};

(async () => {
  if (config.pages.length === 0) {
    return console.error("Please check your configuration");
  }
  for (const i in config.pages) {
    const pageConfig = config.pages[i];
    if (pageConfig.rotation % 90 > 0) {
      return console.error(
        `Invalid rotation value for entry ${i + 1}: ${pageConfig.rotation}`
      );
    }
  }

  if (config.realTime) {
    console.log(`Operating in realtime mode with cache.`);
  }

  if (config.mqttServer) {
    mqttConnect();
  }

  console.log("Starting browser...");
  browser = await puppeteer.launch({
    args: [
      "--disable-dev-shm-usage",
      "--no-sandbox",
      `--lang=${config.language}`,
      config.ignoreCertificateErrors && "--ignore-certificate-errors"
    ].filter((x) => x),
    headless: config.debug !== true
  });

  console.log(`Visiting '${config.baseUrl}' to login...`);
  let page = await browser.newPage();
  await page.goto(config.baseUrl, {
    timeout: config.renderingTimeout
  });

  const hassTokens = {
    hassUrl: config.baseUrl,
    access_token: config.accessToken,
    token_type: "Bearer"
  };

  console.log("Adding authentication entry to browser's local storage...");
  await page.evaluate(
    (hassTokens, selectedLanguage) => {
      localStorage.setItem("hassTokens", hassTokens);
      localStorage.setItem("selectedLanguage", selectedLanguage);
    },
    JSON.stringify(hassTokens),
    JSON.stringify(config.language)
  );

  page.close();

  if (config.debug) {
    console.log(
      "Debug mode active, will only render once in non-headless model and keep page open"
    );
    renderAndConvertAsync(browser);
  } else {
    console.log("Starting first render...");
    renderAndConvertAsync(browser);
    if (!config.realTime) {
      console.log("Starting rendering cronjob...");
      new CronJob({
        cronTime: config.cronJob,
        onTick: () => renderAndConvertAsync(browser),
        start: true
      });
    }
  }

  const httpServer = http.createServer(async (request, response) => {
    // Parse the request
    console.log(`received request from ${request.connection.remoteAddress} for ${request.url}`);

    // support to kill the process
    if (request.url == '/exit') {
        process.exit(1);
        return;
    }

    const url = new URL(request.url, `http://${request.headers.host}`);
    // Check the page number
    const pageNumberStr = url.pathname;
    const pageNumber =
      pageNumberStr === "/" ? 0 : parseInt(pageNumberStr.substr(1));
    if (
      isFinite(pageNumber) === false ||
      pageNumber > config.pages.length ||
      pageNumber < 0
    ) {
      console.log(`Invalid request: ${request.url} for page ${pageNumber}`);
      response.writeHead(404);
      response.end("Invalid request");
      return;
    }
    if (pageNumber == 0) {
      await renderIndexAsync(response);
      return;
    }

    try {
      // Log when the page was accessed
      const n = new Date();
      console.log(`Image ${pageNumber} was accessed`);
      saveState(request);

      const pageIndex = pageNumber - 1;
      const pageConfig = config.pages[pageIndex];

      if (config.realTime) {
        if (Math.round((new Date()) - pageCacheTimes[pageConfig.screenShotUrl])/1000 > pageConfig.realTimeCacheSec) {
        await renderAndConvertPageAsync(browser, pageConfig);
        } else {
          console.log(`returning cached version of ${pageConfig.screenShotUrl}`);
        }
      }

      const data = await fs.readFile(pageConfig.outputPath);
      const stat = await fs.stat(pageConfig.outputPath);

      const lastModifiedTime = new Date(stat.mtime).toUTCString();

      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": Buffer.byteLength(data),
        "Last-Modified": lastModifiedTime
      });
      response.end(data);

    } catch (e) {
      console.error(e);
      response.writeHead(404);
      response.end("Image not found");
    }
  });

  const port = config.port || 5000;
  httpServer.listen(port, () => {
    console.log(`Server is running at ${port}`);
  });
})();

async function mqttConnect() {
  const updateTopic = `homeassistant/screenshot/update`;

  console.log(`Attempting to connect to mqtt://${config.mqttServer}`);
  mqttClient = mqtt.connect(`mqtt://${config.mqttServer}`, {
    clientId: "hass-screenshot",
    username: config.mqttUser,
    password: config.mqttPassword
  });

  mqttClient.on("connect", function () {
    console.log("MQTT Connected!");
    mqttClient.subscribe(updateTopic, (err) => {
      if (!err) {
        console.log("Subscribed to MQTT screenshot update topic");
      } else {
        console.error("Failed to subscribe:", err);
      }
    });
  });

  mqttClient.on("error", function (error) {
    console.error("MQTT error:" + error);
  });

  mqttClient.on("message", async function (topic, message) {
    if (topic === "homeassistant/screenshot/update") {
      const pageNumber = parseInt(message.toString(), 10);
  
      if (isNaN(pageNumber) || pageNumber < 0 || pageNumber > config.pages.length) {
        console.error("Invalid page number received:", message.toString());
        return;
      }
  
      if (!browser) {
        console.error("Error: Puppeteer browser instance is not initialized.");
        return;
      }
  
      if (pageNumber === 0) {
        console.log(`Received MQTT request to update all screenshots.`);
        for (const pageConfig of config.pages) {
          await renderAndConvertPageAsync(browser, pageConfig);
        }
        console.log(`All pages updated.`);
      } else {
        console.log(`Received MQTT request to update screenshot for page ${pageNumber}`);
        const pageConfig = config.pages[pageNumber - 1];
        await renderAndConvertPageAsync(browser, pageConfig);
      }
    }
  });
}

async function mqttSendState(state) {
  if (!state || !state.name || state.name.length == 0) {
    return;
  }
  if (!mqttClient || ! mqttClient.connected) {
    console.error(`MQTT error: no client to send for ${state.name}`);
    return;
  }

  const qos = 1;
  const retain = true;
  const configTopic = `homeassistant/sensor/displays/${state.name}/config`;
  const stateTopic = `homeassistant/sensor/displays/${state.name}/state`;

  var config = {
    unique_id: state.name,
    device_class: "battery",
    state_class: "measurement",
    name: state.name,
    state_topic: stateTopic,
    unit_of_measurement: "%",
    value_template: "{{ value_json.battery_level }}",
    json_attributes_topic: stateTopic,
    json_attributes_template: "{{ value_json | tojson }}",
    expire_after: 60*60, // 1hr in seconds 
  };

  if (state.mac_address) {
    config.unique_id = `${config.unique_id}_${state.mac_address}`
  }

  // send config
  var configString = JSON.stringify(config)
  console.log(`MQTT sending config: ${configString}`);
  await mqttClient.publish(configTopic, configString, { qos: qos, retain: retain }, (error) => {
    if (error) {
      console.error(`MQTT config publish error "${topic}": ${error}`);
    }
  })

  // send state
  var stateString = JSON.stringify(state)
  console.log(`MQTT sending state: ${stateString}`);
  await mqttClient.publish(stateTopic, stateString, { qos: qos, retain: retain }, (error) => {
    if (error) {
      console.error(`MQTT state publish error "${topic}": ${error}`);
    }
  })
}

async function renderIndexAsync(response) {
  // console.log(`Rendering Index`);
  response.writeHead(200, {
    "Content-Type": "text/html",
  });

  var index = "<html><head><title>HASS Screenshots</title></head><body><h1>Screenshots</h1><ul>";
  for (let pageIndex = 0; pageIndex < config.pages.length; pageIndex++) {
    const pageConfig = config.pages[pageIndex];
    const pageNum = pageIndex+1;

    index += `<li><h3><a href="/${pageNum}.png">${pageNum} - ${pageConfig.screenShotUrl}</a></h3> [${pageCacheTimes[pageConfig.screenShotUrl]}]</li>`;
  }
  index += `</ul><h3>State</h3><pre>${JSON.stringify(stateStore, null, 2)}</pre></body></html>`;

  response.end(index);
}

async function saveState(request) {
  var state = {};

  const headerPrefix = 'x-hass-';
  for (const h in request.headers) {
    if (h.startsWith(headerPrefix)) {
      key = h.substring(headerPrefix.length);
      var value = request.headers[h];
      if (Number(value)) {
        value = Number(value);
      }
      if (typeof value === 'string' && value.toLowerCase() == 'true') {
        value = true;
      }
      if (typeof value === 'string' && value.toLowerCase() == 'false') {
        value = false;
      }
      state[key] = value;
    }
  }

  const deviceName = state["name"];
  if (!deviceName || deviceName == '') {
    return;
  }

  state['last_seen'] = new Date();
  if (stateStore[deviceName] && stateStore[deviceName]['last_seen']) {
    state['update_interval'] = Math.round((state['last_seen'] - stateStore[deviceName]['last_seen'])/1000);
  }

  // console.log(`DEBUG: new state: ${JSON.stringify(state)}`);
  stateStore[deviceName] = state;
  if (config.mqttServer) {
    mqttSendState(state);
  }
}

async function renderAndConvertAsync(browser) {
  for (let pageIndex = 0; pageIndex < config.pages.length; pageIndex++) {
    const pageConfig = config.pages[pageIndex];
    await renderAndConvertPageAsync(browser, pageConfig);
  }
}

async function renderAndConvertPageAsync(browser, pageConfig) {
  const url = `${config.baseUrl}${pageConfig.screenShotUrl}`;

  const outputPath = pageConfig.outputPath;
  await fsExtra.ensureDir(path.dirname(outputPath));

  const tempPath = outputPath + ".temp";

  console.log(`Rendering ${url} to image...`);

  try {
    await renderUrlToImageAsync(browser, pageConfig, url, tempPath);
  } catch (e) {
    console.error(`Failed to render ${url}`);
    console.error(`Error: ${e}`);
    return
  }

  console.log(`Converting rendered screenshot of ${url} to grayscale png...`);
  await convertImageToCompatiblePngAsync(
    pageConfig,
    tempPath,
    outputPath
  );

  fs.unlink(tempPath);
  console.log(`Finished ${url}`);
  pageCacheTimes[pageConfig.screenShotUrl] = new Date();

  // Send MQTT message to notify completion
  if (mqttClient && mqttClient.connected) {
    const message = {
      page: pageConfig.screenShotUrl,
      timestamp: new Date().toISOString(),
      outputPath: outputPath
    };

    const topic = "homeassistant/screenshot/updated";
    mqttClient.publish(topic, JSON.stringify(message), { qos: 1, retain: false }, (error) => {
      if (error) {
        console.error(`MQTT publish error on topic "${topic}": ${error}`);
      } else {
        console.log(`MQTT update notification sent for ${pageConfig.screenShotUrl}`);
      }
    });
  }
}

async function renderUrlToImageAsync(browser, pageConfig, url, path) {
  let page;
  try {
    page = await browser.newPage();
    await page.emulateMediaFeatures([
      {
        name: "prefers-color-scheme",
        value: `${pageConfig.prefersColorScheme}`
      }
    ]);

    let size = {
      width: Number(pageConfig.renderingScreenSize.width),
      height: Number(pageConfig.renderingScreenSize.height)
    };

    if (pageConfig.rotation % 180 > 0) {
      size = {
        width: size.height,
        height: size.width
      };
    }

    await page.setViewport(size);
    const startTime = new Date().valueOf();
    await page.goto(url, {
      waitUntil: ["domcontentloaded", "load", "networkidle0"],
      timeout: config.renderingTimeout
    });

    const navigateTimespan = new Date().valueOf() - startTime;
    await page.waitForSelector("home-assistant", {
      timeout: Math.max(config.renderingTimeout - navigateTimespan, 1000)
    });

    await page.addStyleTag({
      content: `
        body {
          width: calc(${size.width}px / ${pageConfig.scaling});
          height: calc(${size.height}px / ${pageConfig.scaling});
          transform-origin: 0 0;
          transform: scale(${pageConfig.scaling});
          overflow: hidden;
        }`
    });

    if (pageConfig.renderingDelay > 0) {
      await page.waitForTimeout(pageConfig.renderingDelay);
    }
    await page.screenshot({
      path,
      type: "png",
      captureBeyondViewport: false,
      clip: {
        x: 0,
        y: 0,
        ...size
      }
    });
  } finally {
    if (config.debug === false) {
      await page.close();
    }
  }
}

function convertImageToCompatiblePngAsync(
  pageConfig,
  inputPath,
  outputPath
) {
  return new Promise((resolve, reject) => {
    gm(inputPath)
      .options({
        imageMagick: config.useImageMagick === true
      })
      .gamma(pageConfig.removeGamma ? 1.0/2.2 : 1.0)
      .dither(pageConfig.dither)
      .rotate("white", pageConfig.rotation)
      //.map("/app/colortable8.png")
      .type(pageConfig.colorMode)
      .bitdepth(pageConfig.grayscaleDepth)
      .quality(100)
      .write(outputPath, (err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
  });
}
