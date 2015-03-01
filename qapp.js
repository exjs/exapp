// QApp <https://github.com/jshq/qapp>
(function($export, $as) {
"use strict";

// \namespace `qapp`
//
// QApp namespace, contains exposed API and constants.
function qapp(opt) {
  return new App(opt);
}

// ============================================================================
// [Constants]
// ============================================================================

var kPending  = qapp.kPending  = 0;
var kStarting = qapp.kStarting = 1;
var kRunning  = qapp.kRunning  = 2;
var kStopping = qapp.kStopping = 3;
var kStopped  = qapp.kStopped  = 4;
var kFailed   = qapp.kFailed   = -1;

// ============================================================================
// [Internals]
// ============================================================================

var hasOwn = Object.prototype.hasOwnProperty;
var isArray = Array.isArray;
var slice = Array.prototype.slice;

function merge(dst, src) {
  for (var k in src)
    dst[k] = src[k];
  return dst;
}

// ============================================================================
// [BufferedLogger]
// ============================================================================

var LogSilly = ["silly"];
var LogDebug = ["debug"];
var LogInfo = ["info"];
var LogWarn = ["warn"];
var LogError = ["error"];

// Logger that is initialized if no default logger is provided. It buffers all
// logs and once a real logger is plugged in all messages can be send to it.
function BufferedLogger() {
  this._logs = [];
}
merge(BufferedLogger.prototype, {
  log: function() {
    this._logs.push(slice.call(arguments, 0));
  },

  silly: function() {
    this._logs.push(LogSilly.concat(slice.call(arguments, 0)));
  },

  debug: function() {
    this._logs.push(LogDebug.concat(slice.call(arguments, 0)));
  },

  info: function() {
    this._logs.push(LogInfo.concat(slice.call(arguments, 0)));
  },

  warn: function() {
    this._logs.push(LogWarn.concat(slice.call(arguments, 0)));
  },

  error: function() {
    this._logs.push(LogError.concat(slice.call(arguments, 0)));
  }
});

// ============================================================================
// [Helpers]
// ============================================================================

function checkModule(m) {
  if (m == null || typeof m !== "object")
    return false;

  var name = m.name;
  if (typeof name !== "string" || name.length === 0 || name === "__proto__")
    return false;

  return isArray(m.deps) && typeof m.start === "function";
}

function printModule(m) {
  if (m == null && typeof m !== "object")
    return "<" + (m === null ? "null" : typeof m) + ">";
  else
    return "<" + (m.name ? m.name : "invalid") + ">";
}

function comparePriority(a, b) {
  return (a.priority || 0) - (b.priority || 0);
}

function resolveDependencies(registered, required) {
  // All modules to be initialized (map and array)
  var map = {};
  var req = [];

  var module, name;
  var deps, dependency;

  var i, j;

  // Fill all modules if required contains "*".
  if (required.indexOf("*") !== -1) {
    for (name in registered) {
      map[name] = false;
      req.push(name);
    }
  }

  // Fill `map` and `req` by module names specified by `required` argument.
  for (i = 0; i < required.length; i++) {
    name = required[i];
    if (hasOwn.call(map, name) || name === "*")
      continue;

    map[name] = false;
    req.push(name);
  }

  // Add all dependency names to `map` and `req`. The `req` array can grow
  // during the loop, but only module names that aren't in `map` are added.
  // In other words, `req` will still contain unique module names after the
  // loop ends.
  for (i = 0; i < req.length; i++) {
    name = req[i];

    if (!hasOwn.call(registered, name))
      return Error("Module '" + name + "' not found");

    module = registered[name];
    deps = module.deps;

    for (j = 0; j < deps.length; j++) {
      dependency = deps[j];
      if (hasOwn.call(map, dependency))
        continue;

      if (!hasOwn.call(registered, dependency))
        return Error("Module '" + name + "' dependency '" + dependency + "' not found.");

      if (hasOwn.call(map, dependency))
        continue;

      map[dependency] = false;
      req.push(dependency);
    }
  }

  // Resolve the order of initialization of modules specified in `req`. All
  // modules that are already initialized will set `map[name]` to `true`.
  var result = [];
  var modulesCount = req.length;

  var resolved = [];
  var unresolved = [];

  var tmp;
  var isOk;
  var hasPriority;

  while (result.length !== modulesCount) {
    resolved.length = 0;
    hasPriority = false;

    // Collect all modules that can be initialized right now.
    for (i = 0; i < req.length; i++) {
      name = req[i];

      // Already resolved.
      if (map[name] === true)
        continue;

      module = registered[name];
      deps = module.deps;
      isOk = true;

      for (j = 0; j < deps.length; j++) {
        dependency = deps[j];
        if (map[dependency] === false) {
          isOk = false;
          break;
        }
      }

      if (isOk) {
        resolved.push(module);
        if (module.priority)
          hasPriority = true;
      }
      else {
        unresolved.push(name);
      }
    }

    if (resolved.length === 0)
      return Error("Cyclic dependency when resolving '" + req.join("', '") + "'.");

    // If priority has been set in one or more module, sort by priority.
    if (hasPriority)
      resolved.sort(comparePriority);

    // Ok now push all modules from `thisRun` into the `result` array.
    for (i = 0; i < resolved.length; i++) {
      module = resolved[i];
      name = module.name;

      map[name] = true;
      result.push(name);
    }

    // Swap `req` and `unresolved` and clear `unresolved`.
    tmp = req;
    req = unresolved;
    unresolved = tmp;
    unresolved.length = 0;
  }

  return result;
}

function makeCallback(app, type, module, next) {
  var n = 0;
  return function(err) {
    if (++n !== 1) {
      // Put to log just once.
      if (n === 2)
        app.error("[APP] Module '" + module.name + "' callbacked " + type + "() twice.");
      throw new Error("Module '" + module.name + "' callbacked " + type + "() " + n + " times.");
    }
    next(err);
  };
}

function callAsync(fn, err) {
  setImmediate(fn, err);
}

// ============================================================================
// [App]
// ============================================================================

// \class `qapp.App`
//
// Application class.
function App(opt) {
  if (!opt)
    opt = {};

  // Application arguments / configuration [PUBLIC].
  this.args   = opt.args   || {};
  this.config = opt.config || {};

  // Application logging interface [PUBLIC].
  this.logger = opt.logger || null;

  // Application internals [PRIVATE].
  this._internal = {
    state      : kPending, // Application's state.
    registered : {},       // Modules registered.
    running    : {},       // Modules running.
    initIndex  : -1,       // Module initialization index.
    initOrder  : null      // Module initialization order.
  };

  // Setup logger, bail to BufferedLogger if there is no logger in `opt`.
  if (this.logger === null)
    this.switchToBufferedLogger();

  // Add modules, these can use built-in logger.
  if (opt.modules)
    this.register(opt.modules);
}

merge(App.prototype, {
  // --------------------------------------------------------------------------
  // [Logging Interface]
  // --------------------------------------------------------------------------

  log: function(/*...*/) {
    var logger = this.logger;
    logger.log.apply(logger, arguments);
    return this;
  },

  silly: function(msg /*[, ...]*/) {
    var logger = this.logger;
    if (arguments.length === 1)
      logger.log("silly", msg);
    else
      logger.log.apply(LogSilly.concat(slice.call(arguments)));
    return this;
  },

  debug: function(msg /*[, ...]*/) {
    var logger = this.logger;
    if (arguments.length === 1)
      logger.log("debug", msg);
    else
      logger.log.apply(LogDebug.concat(slice.call(arguments)));
    return this;
  },

  info: function(msg /*[, ...]*/) {
    var logger = this.logger;
    if (arguments.length === 1)
      logger.log("info", msg);
    else
      logger.log.apply(LogInfo.concat(slice.call(arguments)));
    return this;
  },

  warn: function(msg /*[, ...]*/) {
    var logger = this.logger;
    if (arguments.length === 1)
      logger.log("warn", msg);
    else
      logger.log.apply(LogWarn.concat(slice.call(arguments)));
    return this;
  },

  error: function(msg /*[, ...]*/) {
    var logger = this.logger;
    if (arguments.length === 1)
      logger.log("error", msg);
    else
      logger.log.apply(LogError.concat(slice.call(arguments)));
    return this;
  },

  switchToBufferedLogger: function() {
    this.logger = new BufferedLogger();
    return this;
  },

  switchToExternalLogger: function(logger) {
    var prev = this.logger;
    this.logger = logger;

    if (prev && isArray(prev._logs)) {
      var logs = prev._logs;
      for (var i = 0; i < logs.length; i++)
        this.log.apply(this, logs[i]);
    }

    return this;
  },

  // --------------------------------------------------------------------------
  // [Module Interface]
  // --------------------------------------------------------------------------

  // \function `App.register(m)`
  //
  // Register a single module or multiple modules, specifed by `m`.
  //
  // If a module is registered it doesn't mean it has to run, it means that it's
  // available to be instantiated. Modules to be run are passed in `App.start()`.
  register: function(m) {
    if (isArray(m)) {
      var modules = m;
      for (var i = 0, len = modules.length; i < len; i++) {
        m = modules[i];
        if (!checkModule(m))
          throw new TypeError("Invalid signature of a module[" + i + "] " + printModule(m) + ".");
        this._register(m);
      }
    }
    else {
      if (!checkModule(m))
        throw new TypeError("Invalid signature of module " + printModule(m) + ".");
      this._register(m);
    }

    return this;
  },

  // \internal
  _register: function(m) {
    this._internal.registered[m.name] = m;
  },

  // \function `App.isModuleRegistered(m)`
  //
  // Get whether the module `m` has been registered.
  isModuleRegistered: function(m) {
    var internal = this._internal;

    if (typeof m === "string")
      return hasOwn.call(internal.registered, m);
    else if (checkModule(m))
      return hasOwn.call(internal.registered, m.name);
    else
      throw new TypeError("Invalid argument.");
  },

  // \function `App.isModuleRunning(m)`
  //
  // Get whether the module `m` is running.
  isModuleRunning: function(m) {
    var internal = this._internal;

    if (typeof m === "string")
      return hasOwn.call(internal.loaded, m);
    else if (checkModule(m))
      return hasOwn.call(internal.loaded, m.name);
    else
      throw new TypeError("Invalid argument.");
  },

  // \function `App.getModulesRegistered()`
  //
  // Get all modules registered as a mapping between module names and objects.
  getModulesRegistered: function() {
    return this._internal.registered;
  },

  // \function `App.getModulesRunning()`
  //
  // Get all modules running as a mapping between module names and objects.
  getModulesRunning: function() {
    return this._internal.running;
  },

  // --------------------------------------------------------------------------
  // [Lifetime Interface]
  // --------------------------------------------------------------------------

  getState: function() {
    return this._internal.state;
  },

  // \function `App.isRunning()`
  //
  // Get whether the application is started (i.e. all modules started).
  isRunning: function() {
    return this._internal.state === kRunning;
  },

  // \function `App.isStopped()`
  //
  // Get whether the application is stopped (i.e. all modules stopped).
  isStopped: function() {
    return this._internal.state === kStopped;
  },

  // \function `App.start(required, cb)`
  //
  // Start the application.
  start: function(required, cb) {
    var self = this;
    var internal = this._internal;

    if (internal.state !== kPending) {
      var msg = "Attempt to start app multiple times.";

      self.log("error", "[APP] " + msg);
      throw new Error(msg);
    }

    self.log("silly", "[APP] Starting.");
    internal.state = kStarting;

    var order = resolveDependencies(internal.registered, required);
    var module = null;

    if (order instanceof Error) {
      internal.state = kFailed;
      callAsync(cb, order);

      return this;
    }

    var syncOk = 0;
    var index;

    internal.initIndex = -1;
    internal.initOrder = order;

    function iterate(err) {
      if (err) {
        self.log("error", "[APP] Module '" + module.name + "' failed to start: " + err.message);

        internal.state = kFailed;
        return callAsync(cb, err);
      }

      // Return immediately and handle the result without recursing if sync.
      if (--syncOk === 0)
        return;

      for (;;) {
        index = ++internal.initIndex;
        syncOk = 1;

        if (index >= order.length) {
          self.log("silly", "[APP] Running.");

          internal.state = kRunning;
          return callAsync(cb, null);
        }

        module = internal.registered[order[index]];
        self.log("silly", "[APP] Module '" + module.name + "' starting.");

        try {
          module.start(self, makeCallback(self, "start", module, iterate));
        } catch (ex) {
          self.log("error", "[APP] Module '" + module.name + "' failed to start (thrown): " + ex.message);

          internal.state = kFailed;
          return callAsync(cb, ex);
        }

        if (++syncOk !== 1)
          break;
      }
    }

    iterate(null);
    return this;
  },

  // \function `App.stop(cb)`
  //
  // Stop the application.
  stop: function(cb) {
    var self = this;
    var internal = this._internal;

    if (internal.state !== kRunning) {
      var msg = internal.state < kRunning
        ? "Attempt to stop a non-running app."
        : "Attempt to stop app multiple times.";

      self.log("error", "[APP] " + msg);
      throw new Error(msg);
    }

    self.log("silly", "[APP] Stopping.");
    internal.state = kStopping;

    var order = internal.initOrder;
    var module = null;

    var syncOk = 0;
    var index;

    function iterate(err) {
      if (err) {
        self.log("error", "[APP] Module '" + module.name + "' failed to stop: " + err.message);

        internal.state = kFailed;
        return callAsync(cb, err);
      }

      // Return immediately and handle the result without recursing if sync.
      if (--syncOk === 0)
        return;

      for (;;) {
        index = --internal.initIndex;
        syncOk = 1;

        if (index === -1) {
          self.log("silly", "[APP] Stopped.");

          internal.state = kStopped;
          return callAsync(cb, null);
        }

        module = internal.registered[order[index]];
        self.log("silly", "[APP] Module '" + module.name + "' stopping" + (module.stop ? "" : " (no callback)") + ".");

        if (typeof module.stop === "function") {
          try {
            module.stop(self, makeCallback(self, "stop", module, iterate));
          } catch (ex) {
            self.log("error", "[APP] Module '" + module.name + "' failed to stop (thrown): " + ex.message);

            internal.state = kFailed;
            return callAsync(cb, ex);
          }

          if (++syncOk !== 1)
            break;
        }
      }
    }

    iterate(null);
    return this;
  }
});
qapp.App = App;

$export[$as] = qapp;

}).apply(this, typeof module === "object" ? [module, "exports"] : [this, "qapp"]);