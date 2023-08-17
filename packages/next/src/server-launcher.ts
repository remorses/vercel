import { IncomingMessage, ServerResponse } from 'http';

// The Next.js builder can emit the project in a subdirectory depending on how
// many folder levels of `node_modules` are traced. To ensure `process.cwd()`
// returns the proper path, we change the directory to the folder with the
// launcher. This mimics `yarn workspace run` behavior.
process.chdir(__dirname);

const region = process.env.VERCEL_REGION || process.env.NOW_REGION;

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = region === 'dev1' ? 'development' : 'production';
}

if (process.env.NODE_ENV !== 'production' && region !== 'dev1') {
  console.warn(
    `Warning: NODE_ENV was incorrectly set to "${process.env.NODE_ENV}", this value is being overridden to "production"`
  );
  process.env.NODE_ENV = 'production';
}

// pre-next-server-target
let alreadyRan = false;
module.exports = async (req: IncomingMessage, res: ServerResponse) => {
  async function handle(req: IncomingMessage, res: ServerResponse) {
    alreadyRan = true;
    // eslint-disable-next-line
    const NextServer = require('__NEXT_SERVER_PATH__').default;
    const nextServer = new NextServer({
      // @ts-ignore __NEXT_CONFIG__ value is injected
      conf: __NEXT_CONFIG__,
      dir: '.',
      minimalMode: true,
      customServer: false,
    });
    const requestHandler = nextServer.getRequestHandler();
    try {
      // entryDirectory handler
      return await requestHandler(req, res);
    } catch (err) {
      console.error(err);
      // crash the lambda immediately to clean up any bad module state,
      // this was previously handled in ___vc_bridge on an unhandled rejection
      // but we can do this quicker by triggering here
      process.exit(1);
    }
  }

  if (!req?.url?.includes('vercel-profile')) {
    return await handle(req, res);
  }

  if (alreadyRan) {
    for (const k of Object.keys(require.cache)) {
      delete require.cache[k];
    }
  }
  const pageName =
    req?.url?.replace(/\?.*/, '').split('/').filter(Boolean).join('-') ||
    'page';

  if (req?.url?.includes('vercel-profile-require')) {
    createShim();
    const { Writable } = require('stream');
    await handle(
      req,
      new ServerResponse(
        new Writable({
          // @ts-ignore
          write(chunk, encoding, callback) {
            // Discard the data
            callback();
          },
        })
      )
    );
    const filename = `${pageName}-${
      alreadyRan ? 'hot' : 'cold'
    }-require-time.cpuprofile`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    const profileData = JSON.stringify(events);
    events.length = 0;
    res.end(profileData);
    return;
  }

  const inspector = require('inspector');
  const session = new inspector.Session();
  session.connect();
  await new Promise((resolve, reject) => {
    session.post('Profiler.enable', () => {
      // Start profiling
      session.post('Profiler.start', async () => {
        // Run your Node.js program or perform the operations you want to profile
        console.time('cold start');
        const { Writable } = require('stream');

        await handle(
          req,
          new ServerResponse(
            new Writable({
              // @ts-ignore
              write(chunk, encoding, callback) {
                // Discard the data
                callback();
              },
            })
          )
        );
        console.timeEnd('cold start');
        // Stop profiling
        session.post(
          'Profiler.stop',
          async (err: Error | null, { profile }: any) => {
            if (err) {
              console.error(err);
              reject(err);
              return;
            }
            // Save the profile to a file
            const profileData = JSON.stringify(profile);

            session.disconnect();

            const filename = `${pageName}-${
              alreadyRan ? 'hot' : 'cold'
            }-start.cpuprofile`;
            res.setHeader(
              'Content-Disposition',
              `attachment; filename="${filename}"`
            );
            res.setHeader('Content-Type', 'application/json');

            res.end(profileData);

            resolve(profileData);
          }
        );
      });
    });
  });
  return;
};

const MODULE = require('module');

const REQUIRE_SO_SLOW = Symbol('require-monkey-patch');

function createShim() {
  const orig = MODULE._load;
  if (orig[REQUIRE_SO_SLOW]) {
    return;
  }
  MODULE._load = function _load(request: string) {
    // eslint-disable-next-line prefer-rest-params
    const args = arguments;
    let exports;
    const start = now();
    try {
      exports = orig.apply(this, args);
    } finally {
      const end = now();
      // const k = path.relative(process.cwd(), parent.filename);
      events.push({
        name: `require ${request}`,
        ph: 'X',
        pid: 1,
        ts: start,
        dur: end - start,
      });
    }

    return exports;
  };
  MODULE._load[REQUIRE_SO_SLOW] = true;
}

type Microseconds = number;

/** @return a high-res timestamp of the current time. */
function now(): Microseconds {
  const [sec, nsec] = process.hrtime();
  return sec * 1e6 + nsec / 1e3;
}

/**
 * The type of entries in the Chrome Trace format:
 * https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/edit
 * Field names are chosen to match the JSON format.
 */
interface Event {
  name: string;
  ph: 'B' | 'E' | 'X' | 'C';
  pid: number; // Required field in the trace viewer, but we don't use it.
  ts: Microseconds;
  dur?: Microseconds;
  args?: { [name: string]: number };
}

const events: Event[] = [];
