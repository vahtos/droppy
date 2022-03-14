"use strict";

const resources = module.exports = {};
const etag = require("etag");
const fs = require("fs");
const jb = require("json-buffer");
const path = require("path");
const vm = require("vm");
const {constants, gzip, brotliCompress} = require("zlib");
const {stat, mkdir, readdir, readFile, writeFile} = require("fs").promises;
const {promisify} = require("util");

const log = require("./log.js");
const paths = require("./paths.js").get();
const utils = require("./utils.js");

const themesPath = path.join(paths.client, "/node_modules/codemirror/theme");
const modesPath = path.join(paths.client, "/node_modules/codemirror/mode");
const cachePath = process.env.DROPPY_CACHE_PATH ?? path.join(paths.homedir, "/.droppy/cache/cache.json");

const pkg = require("../../package.json");

const gzipEncode = (data) => promisify(gzip)(data, {level: constants.Z_BEST_COMPRESSION});
const brotliEncode = (data) => promisify(brotliCompress)(data, {
  [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY
});

let minify;

const opts = {
  terser: {
    mangle: true,
    compress: {
      booleans: true,
      collapse_vars: true,
      conditionals: true,
      comparisons: true,
      dead_code: true,
      keep_fargs: false,
      drop_debugger: true,
      evaluate: true,
      hoist_funs: true,
      if_return: true,
      negate_iife: true,
      join_vars: true,
      loops: true,
      properties: true,
      reduce_vars: true,
      sequences: true,
      toplevel: true,
      unsafe: true,
      unsafe_proto: true,
      unused: true,
    },
  },
  cleanCSS: {
    level: {
      1: {
        specialComments: 0,
      },
      2: {
        all: false,
        mergeMedia: true,
        removeDuplicateMediaBlocks: true,
        removeDuplicateRules: true,
      },
    },
    rebase: false,
  },
  autoprefixer: {
    cascade: false,
  },
  htmlMinifier: {
    caseSensitive: true,
    collapseBooleanAttributes: true,
    collapseInlineTagWhitespace: true,
    collapseWhitespace: true,
    customAttrSurround: [
      [/{{#.+?}}/, /{{\/.+?}}/]
    ],
    decodeEntities: true,
    ignoreCustomComments: [],
    ignoreCustomFragments: [/{{[\s\S]*?}}/],
    includeAutoGeneratedTags: false,
    minifyCSS: {
      specialComments: 0,
      rebase: false,
    },
    removeAttributeQuotes: true,
    removeComments: true,
    removeOptionalTags: true,
    removeRedundantAttributes: true,
    removeTagWhitespace: true,
  }
};

let autoprefixer, cleanCSS, postcss, terser, htmlMinifier, svg, handlebars;
try {
  autoprefixer = require("autoprefixer");
  cleanCSS = new (require("clean-css"))(opts.cleanCSS);
  handlebars = require("handlebars");
  htmlMinifier = require("html-minifier");
  postcss = require("postcss");
  terser = require("terser");
  svg = require("./svg.js");
} catch {}

resources.files = {
  css: [
    `${paths.client}/lib/style.css`,
    `${paths.client}/lib/sprites.css`,
    `${paths.client}/lib/tooltips.css`,
    `${paths.client}/lib/clienttheme.css`,
  ],
  js: [
    "node_modules/handlebars/dist/handlebars.runtime.min.js",
    "node_modules/file-extension/file-extension.js",
    "node_modules/screenfull/dist/screenfull.js",
    "node_modules/mousetrap/mousetrap.min.js",
    "node_modules/uppie/uppie.js",
    "node_modules/jquery/dist/jquery.min.js",
    "lib/client.js",
  ],
  other: [
    "lib/images/logo.svg",
    "lib/images/logo32.png",
    "lib/images/logo120.png",
    "lib/images/logo128.png",
    "lib/images/logo152.png",
    "lib/images/logo180.png",
    "lib/images/logo192.png",
    "lib/images/sprites.png",
  ]
};

// On-demand loadable libs. Will be available as !/res/lib/[prop]
const libs = {
  // plyr
  "plyr.js": ["node_modules/plyr/dist/plyr.polyfilled.min.js"],
  "plyr.css": ["node_modules/plyr/dist/plyr.css"],
  "plyr.svg": ["node_modules/plyr/dist/plyr.svg"],
  "blank.mp4": ["lib/blank.mp4"],
    // codemirror
  "cm.js": [
    "node_modules/codemirror/lib/codemirror.js",
    "node_modules/codemirror/mode/meta.js",
    "node_modules/codemirror/addon/comment/comment.js",
    "node_modules/codemirror/addon/mode/overlay.js",
    "node_modules/codemirror/addon/dialog/dialog.js",
    "node_modules/codemirror/addon/selection/active-line.js",
    "node_modules/codemirror/addon/selection/mark-selection.js",
    "node_modules/codemirror/addon/search/searchcursor.js",
    "node_modules/codemirror/addon/edit/matchbrackets.js",
    "node_modules/codemirror/addon/search/search.js",
    "node_modules/codemirror/keymap/sublime.js"
  ],
  "cm.css": ["node_modules/codemirror/lib/codemirror.css"],
    // photoswipe
  "ps.js": [
    "node_modules/photoswipe/dist/photoswipe.min.js",
    "node_modules/photoswipe/dist/photoswipe-ui-default.min.js",
  ],
  "ps.css": [
    "node_modules/photoswipe/dist/photoswipe.css",
    "node_modules/photoswipe/dist/default-skin/default-skin.css",
  ],
    // photoswipe skin files included by their CSS
  "default-skin.png": ["node_modules/photoswipe/dist/default-skin/default-skin.png"],
  "default-skin.svg": ["node_modules/photoswipe/dist/default-skin/default-skin.svg"],
  "pdf.js": ["node_modules/pdfjs-dist/build/pdf.js"],
  "pdf.worker.js": ["node_modules/pdfjs-dist/build/pdf.worker.js"],
};

resources.load = function(dev, cb) {
  minify = !dev;

  if (dev) return compile(false, cb);
  fs.readFile(cachePath, (err, data) => {
    if (err) {
      log.info(err.code, " ", cachePath, ", ", "building cache ...");
      return compile(true, cb);
    }

    try {
      const json = jb.parse(data);
      //
      // if (!json || !json.meta || !json.meta.version || json.meta.version !== pkg.version) {
      // if (!process.env.DROPPY_CACHE_SKIP_VALIDATIONS) {
      //     log.info("Cache outdated. ", cachePath, ", building cache ...");
      //     return compile(true, cb);
      // }
      // }
      //
      cb(null, json);
    } catch (err2) {
      log.error(err2);
      compile(false, cb);
    }
  });
};

resources.build = function(cb) {
  isCacheFresh(fresh => {
    if (fresh) {
      fs.readFile(cachePath, (err, data) => {
        if (err) return compile(true, cb);
        try {
          jb.parse(data);
          cb(null);
        } catch {
          compile(true, cb);
        }
      });
    } else {
      minify = true;
      compile(true, cb);
    }
  });
};

async function isCacheFresh(cb) {
  let stats;
  try {
    stats = await stat(cachePath);
  } catch {
    return cb(false);
  }

  const files = [];
  for (const type of Object.keys(resources.files)) {
    resources.files[type].forEach(file => {
      if (fs.existsSync(path.join(paths.client, file))) {
        files.push(path.join(paths.client, file));
      } else {
        files.push(file);
      }
    });
  }

  for (const file of Object.keys(libs)) {
    if (typeof libs[file] === "string") {
      if (fs.existsSync(path.join(paths.client, libs[file]))) {
        files.push(path.join(paths.client, libs[file]));
      } else {
        files.push(libs[file]);
      }
    } else {
      libs[file].forEach(file => {
        if (fs.existsSync(path.join(paths.client, file))) {
          files.push(path.join(paths.client, file));
        } else {
          files.push(file);
        }
      });
    }
  }

  const fileStats = await Promise.all(files.map(file => stat(file)));
  const times = fileStats.map(stat => stat.mtime.getTime());
  cb(stats.mtime.getTime() >= Math.max(...times));
}

async function compile(write, cb) {
  if (!autoprefixer) {
    return cb(new Error("Missing devDependencies to compile resource cache, " +
            "please reinstall or run `npm install --only=dev` inside the project directory"));
  }

  const cache = {
    res: {}, themes: {}, modes: {}, lib: {}
  };

  cache.res = await compileAll();

  for (const [theme, data] of Object.entries(await readThemes())) {
    cache.themes[theme] = {
      data,
      etag: etag(data),
      mime: utils.contentType("css"),
    };
  }

  for (const [mode, data] of Object.entries(await readModes())) {
    cache.modes[mode] = {
      data,
      etag: etag(data),
      mime: utils.contentType("js"),
    };
  }

  for (const [file, data] of Object.entries(await readLibs())) {
    cache.lib[file] = {
      data,
      etag: etag(data),
      mime: utils.contentType(file),
    };
  }

  for (const entries of Object.values(cache)) {
    if (!entries.version) {
      await Promise.all(Object.values(entries).map(async props => {
        props.gzip = await gzipEncode(props.data);
        props.brotli = await brotliEncode(props.data);
      }));
    }
  }

  cache["meta"] = {
    version: pkg.version
  };

  if (write) {
    await mkdir(path.dirname(cachePath), {recursive: true});
    await writeFile(cachePath, jb.stringify(cache));
  }
  cb(null, cache);
}

async function readThemes() {
  const themes = {};

  for (const name of await readdir(themesPath)) {
    const data = await readFile(path.join(themesPath, name));
    themes[name.replace(/\.css$/, "")] = Buffer.from(await minifyCSS(String(data)));
  }

  const droppyTheme = await readFile(path.join(paths.client, "/lib/cmtheme.css"));
  themes.droppy = Buffer.from(await minifyCSS(String(droppyTheme)));

  return themes;
}

async function readModes() {
  const modes = {};

    // parse meta.js from CM for supported modes
  const js = await readFile(path.join(paths.client, "/node_modules/codemirror/mode/meta.js"));

    // Extract modes from CodeMirror
  const sandbox = {CodeMirror: {}};
  vm.runInNewContext(js, sandbox);

  for (const entry of sandbox.CodeMirror.modeInfo) {
    if (entry.mode !== "null") modes[entry.mode] = null;
  }

  for (const name of Object.keys(modes)) {
    const data = await readFile(path.join(modesPath, name, `${name}.js`));
    modes[name] = Buffer.from(await minifyJS(String(data)));
  }

  return modes;
}

async function readLibs() {
  const lib = {};

  for (const [dest, files] of Object.entries(libs)) {
    lib[dest] = Buffer.concat(await Promise.all(files.map(file => {
      return readFile(path.join(paths.client, file));
    })));
  }

    // Prefix hardcoded Photoswipe urls
  lib["ps.css"] = Buffer.from(String(lib["ps.css"]).replace(/url\(/gm, "url(!/res/lib/"));

  if (minify) {
    for (const [file, data] of (Object.entries(lib))) {
      if (/\.js$/.test(file)) {
        lib[file] = Buffer.from(await minifyJS(String(data)));
      } else if (/\.css$/.test(file)) {
        lib[file] = Buffer.from(await minifyCSS(String(data)));
      }
    }
  }

  return lib;
}

async function minifyJS(js) {
  if (!minify) return js;
  const min = await terser.minify(js, opts.terser);
  if (min.error) {
    log.error(min.error);
    process.exit(1);
  }
  return min.code;
}

async function minifyCSS(css) {
  if (!minify) return css;
  return cleanCSS.minify(String(css)).styles;
}

function templates() {
  const prefix = "(function(){var template=Handlebars.template," +
        "templates=Handlebars.templates=Handlebars.templates||{};";
  const suffix = "Handlebars.partials=Handlebars.templates})();";

  return prefix + fs.readdirSync(paths.templates).map(file => {
    const p = path.join(paths.templates, file);
    const name = file.replace(/\..+$/, "");
    let html = htmlMinifier.minify(fs.readFileSync(p, "utf8"), opts.htmlMinifier);

        // remove whitespace around {{fragments}}
    html = html.replace(/(>|^|}}) ({{|<|$)/g, "$1$2");

        // trim whitespace inside {{fragments}}
    html = html.replace(/({{2,})([\s\S\n]*?)(}{2,})/gm, (_, p1, p2, p3) => {
      return p1 + p2.replace(/\n/gm, " ").replace(/ {2,}/gm, " ").trim() + p3;
    }).trim();

        // remove {{!-- comments --}}
    html = html.replace(/{{![\s\S]+?..}}/, "");

    const compiled = handlebars.precompile(html, {data: false});
    return `templates['${name}']=template(${compiled});`;
  }).join("") + suffix;
}

resources.compileJS = async function() {
  let js = "";
  resources.files.js.forEach(file => {
    if (fs.existsSync(path.join(paths.client, file))) {
      js += `${fs.readFileSync(path.join(paths.client, file), "utf8")};`;
    } else {
      js += `${fs.readFileSync(file, "utf8")};`;
    }
  });

    // Add templates
  js = js.replace("/* {{ templates }} */", templates());

    // Minify
  js = await minifyJS(js);

  return {
    data: Buffer.from(js),
    etag: etag(js),
    mime: utils.contentType("js"),
  };
};

resources.compileCSS = async function() {
  let css = "";
  resources.files.css.forEach(file => {
    css += `${fs.readFileSync(path.join(file), "utf8")}\n`;
  });

    // Vendor prefixes and minify
  css = await minifyCSS(postcss([autoprefixer(opts.autoprefixer)]).process(css).css);

  return {
    data: Buffer.from(css),
    etag: etag(css),
    mime: utils.contentType("css"),
  };
};

resources.compileHTML = async function(res) {
  let html = fs.readFileSync(path.join(paths.client, "lib", "index.html"), "utf8");
  html = html.replace("<!-- {{svg}} -->", svg());

  let auth = html.replace("{{type}}", "a");
  auth = minify ? htmlMinifier.minify(auth, opts.htmlMinifier) : auth;
  res["auth.html"] = {data: Buffer.from(auth), etag: etag(auth), mime: utils.contentType("html")};

  let first = html.replace("{{type}}", "f");
  first = minify ? htmlMinifier.minify(first, opts.htmlMinifier) : first;
  res["first.html"] = {data: Buffer.from(first), etag: etag(first), mime: utils.contentType("html")};

  let main = html.replace("{{type}}", "m");
  main = minify ? htmlMinifier.minify(main, opts.htmlMinifier) : main;
  res["main.html"] = {data: Buffer.from(main), etag: etag(main), mime: utils.contentType("html")};
  return res;
};

async function compileAll() {
  let res = {};

  res["client.js"] = await resources.compileJS();
  res["style.css"] = await resources.compileCSS();
  res = await resources.compileHTML(res);

    // Read misc files
  for (const file of resources.files.other) {
    const name = path.basename(file);
    const fullPath = path.join(paths.client, file);
    const data = fs.readFileSync(fullPath);
    res[name] = {data, etag: etag(data), mime: utils.contentType(name)};
  }

  return res;
}
