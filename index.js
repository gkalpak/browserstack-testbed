// Super constants
// TODO(gkalpak): Add ability to configure these via CLI options.
const browserName = ['chromeLatest', 'ie9'][0];

// Imports
const {equal} = require('node:assert/strict');
const {exec} = require('node:child_process');
const {createServer, STATUS_CODES} = require('node:http');
const {createReadStream, writeFileSync} = require('node:fs');
const proc = require('node:process');
const {env, stderr, stdout} = proc;
const {parseArgs} = require('node:util');

const {Local: BrowserStackLocal} = require('browserstack-local');
const {remote} = require('webdriverio');


// Types
/** @import {ChildProcess} from 'node:child_process' */
/** @import {Server} from 'node:http' */
/** @import {ParseArgsConfig} from 'node:util' */
/** @import {RemoteOptions} from 'webdriverio' */
/**
 * @typedef {object} BrowserStackTunnel
 * @prop {() => boolean} isRunning
 * @prop {() => Promise<void>} close
 */


// Constants
const tunnelName = 'test-run';

const localHost = 'localhost';
const localPort = 8080;
const localPublicDir = `${__dirname}/public`;

/** @satisfies {ParseArgsConfig['options']} */
const cliOptions = {
  'demo-local': {
    short: 'l',
    type: 'boolean',
    default: false,
  },
  'demo-remote': {
    short: 'r',
    type: 'boolean',
    default: false,
  },
  'bstack-tunnel': {
    short: 't',
    type: 'boolean',
    default: false,
  },
  'server': {
    short: 's',
    type: 'boolean',
    'default': false,
  },
};
const capabilities = {
  chromeLatest: {
    browserName : 'Chrome',
    'bstack:options' : {
      browserVersion: 'latest',
      os: 'OS X',
      osVersion: 'Sequoia',
      buildName: 'Test run',
      buildIdentifier: 'test-run-0',
      consoleLogs: 'verbose',
      debug: true,
      local: true,
      localIdentifier: tunnelName,
    },
  },
  ie9: {
    browserName : 'IE',
    'bstack:options' : {
      browserVersion: '9.0',
      os: 'Windows',
      osVersion: '7',
      buildName: 'Test run',
      buildIdentifier: 'test-run-0',
      consoleLogs: 'verbose',
      debug: true,
      local: true,
      localIdentifier: tunnelName,
    },
  },
};
const userAgentRes = {
  chromeLatest: / Chrome\/\d+\.\d+\.\d+\.\d+ /,
  ie9: / MSIE 9\.0; /,
};

const browserStackOptions = {
  user: env.BROWSERSTACK_USERNAME ?? '',
  key: env.BROWSERSTACK_ACCESS_KEY ?? '',
  localIdentifier: tunnelName,
  force: true,
  forceLocal: true,
  onlyAutomate: true,
  verbose: true,
  logFile: 'browserstack.log',
};

/** @satisfies {RemoteOptions} */
const webdriverRemoteOptions = {
  user: browserStackOptions.user,
  key: browserStackOptions.key,
  logLevel: 'debug',
  capabilities: capabilities[browserName],
};

// Run
_main(parseArgs({options: cliOptions}));

// Helpers
/**
 * @param {ReturnType<typeof parseArgs>} param0
 * @return {Promise<void>}
 */
async function _main({values}) {
  if (values['demo-local']) {
    await runSampleLocalTest();
  } else if (values['demo-remote']) {
    await runSampleTest('https://example.com/');
  } else if (values['bstack-tunnel']) {
    await startBrowserStackTunnel();
  } else if (values['server']) {
    await startLocalServer();
  } else {
    throw new Error(
        'Missing CLI option. You must give one of: ' +
        Object.entries(cliOptions).map(([key, val]) => `--${key} (-${val.short})`).join(', '));
  }
}

/**
 * @param {string} label
 * @return {{error: (msg: string) => void, info: (msg: string) => void}}
 */
function getLogger(label) {
  const transformMsg = msg => `${`${msg}`.trim().replace(/^/gm, `[${label}] `)}\n`;

  return {
    error: msg => stderr.write(transformMsg(msg)),
    info: msg => stdout.write(transformMsg(msg)),
  };
}

/**
 * @return {Promise<void>}
 */
async function runSampleLocalTest() {
  let localServer;

  try {
    localServer = await startLocalServer();
    await runSampleTest(`http://${localHost}:${localPort}/`);
  } finally {
    await localServer?.stop();
  }
}

/**
 * @param {string} url
 * @return {Promise<void>)
 */
async function runSampleTest(url) {
  let bstackTunnel;
  let browser;

  try {
    // Establish BrowserStack tunnel.
    bstackTunnel = await startBrowserStackTunnel();

    // Create WebDriver instance.
    browser = await remote(webdriverRemoteOptions);

    // Run tests.
    await browser.navigateTo(url);

    const userAgent = await browser.execute('return navigator.userAgent');
    const userAgentRe = userAgentRes[browserName];
    equal(userAgentRe.test(userAgent), true);

    const heading = await browser.$('h1');
    equal(await heading.getText(), 'Example Domain');
  } finally {
    // Clean up.
    await browser?.deleteSession();
    await bstackTunnel?.close();
  }

  console.log('\nDone.');
}

/**
 * @return {Promise<BrowserStackTunnel>}
 */
async function startBrowserStackTunnel() {
  /** @type {BrowserStackLocal | null} */
  let bstackTunnel = null;
  /** @type {ChildProcess | null} */
  let logTailProc = null;

  const logger = getLogger('BrowserStack Tunnel');
  /** @type {BrowserStackTunnel} */
  const bstackTunnelProxy = {
    isRunning() { return bstackTunnel?.isRunning() ?? false; },
    async close() {
      if (this.isRunning()) {
        logger.info('Tunnel closing...');

        await new Promise(resolve => bstackTunnel?.stop(() => {
          logger.info('Tunnel closed.');

          /** @type {const} */(['stderr', 'stdin', 'stdout']).forEach(io => logTailProc?.[io]?.destroy());
          const logTailProcStopped = logTailProc?.kill() ?? false;
          logger.info(`Log file ${logTailProcStopped ? '' : 'not '}closed.`);

          bstackTunnel = null;
          logTailProc = null;

          resolve(null);
        }));
      }
    },
  };

  try {
    // Start BrowserStack tunnel.
    bstackTunnel = new BrowserStackLocal();

    // Prepare log file (i.e. create or truncate).
    const logFile = browserStackOptions.logFile ?? 'local.log';
    writeFileSync(logFile, '');

    // TODO(gkalpak): Implement this in an OS-independent way.
    logTailProc = exec(`tail -f ${logFile}`);
    logTailProc.stdout?.on('data', d => logger.info(`${d}`));

    await new Promise(resolve => bstackTunnel?.start(browserStackOptions, () => {
      logger.info('Tunnel established.');

      ['exit', 'SIGINT'].forEach(evt => proc.on(evt, () => bstackTunnelProxy.close()));

      resolve(null);
    }));

    return bstackTunnelProxy;
  } catch (err) {
    // Clean up.
    await bstackTunnelProxy.close();

    throw err;
  }
}

/**
 * @return {Promise<Server & {stop: () => Promise<void>}>}
 */
function startLocalServer() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const logger = getLogger('Local Server');

    server.on('error', err => {
      logger.error(`${err.stack ?? err}`);
      reject(err);
    });

    server.on('listening', () => {
      logger.info(`Server up and running and listening on: http://${localHost}:${localPort}/`);
      resolve(Object.assign(server, {
        stop: () => /** @type {Promise<void>} */(new Promise(resolve => server.close(() => resolve()))),
      }));
    });

    server.on('request', (req, res) => {
      logger.info(`${req.method ?? 'UNKNOWN'} ${req.url ?? ''} (Agent: ${req.headers['user-agent'] ?? 'N/A'})`);

      const url = new URL(`http://${localHost}${req.url}`);
      const originalPathname = url.pathname.replace(/\/$/, '');
      const candidatePathnames = [originalPathname, `${originalPathname}/index.html`];
      let foundFile = false;

      for (const pathname of candidatePathnames) {
        if (foundFile) {
          break;
        }

        switch (pathname) {
          case '/index.html':
            foundFile = true;

            res.writeHead(200, STATUS_CODES['200'], {'Content-Type': 'text/html'});

            const readStream = createReadStream(`${localPublicDir}/${pathname}`);
            readStream.pipe(res);
            readStream.on('end', () => res.end());

            break;
        }
      }

      if (!foundFile) {
        res.writeHead(404, STATUS_CODES['404'], {'Content-Type': 'text/plain'});
        res.end(STATUS_CODES['404']);
      }
    });

    server.listen(localPort, localHost);
  });
}
