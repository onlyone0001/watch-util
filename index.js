var fs = require("fs");
var path = require("path");
var child = require('child_process');

var glob = require("glob");
var chalk = require("chalk");
var psTree = require('ps-tree');
var async = require("async");

var utils = require("./utils");
var debounce = utils.debounce;
var debugLog = utils.debugLog;
var shallowCopyObj = utils.shallowCopyObj;

var isShAvailableOnWin = undefined;
function checkShAvailableOnWin() {
	try {
		var stat = fs.statSync("/bin/sh.exe");
	} catch (err) {
		return false;
	}
	return true;
}


function exec(cmd, options) {
	if (options.shell === true) {
		if (process.platform === 'win32') {
			if (isShAvailableOnWin === undefined) {
				isShAvailableOnWin = checkShAvailableOnWin();
				if (isShAvailableOnWin && options.debug) {
					debugLog("Will use " + chalk.yellow("'C:\\\\bin\\\\sh.exe'") + " as default shell.");
				}
			}

			if (isShAvailableOnWin) {
				var childRunning = child.spawn("/bin/sh", ["-c", cmd], { stdio: options.writeToConsole ? "inherit" : null });
			} else {
				var childRunning = child.spawn(cmd, { shell: true, stdio: options.writeToConsole ? "inherit" : null });
			}
		} else {
			var childRunning = child.spawn(cmd, { shell: true, stdio: options.writeToConsole ? "inherit" : null });
		}
	} else if (typeof(options.shell) === "string") {
		var shellExecutable = options.shell.split(" ")[0];
		var childRunning = child.spawn(shellExecutable, options.shell.split(" ").slice(1).concat([cmd]), { stdio: options.writeToConsole ? "inherit" : null });
	}

	return childRunning;
}

function getProcessChildren(pid, callback) {
	psTree(pid, function (err, children) {
		if (err) { return callback(err); }
		children = children.map(function (c) { return +c.PID; });
		callback(null, children);
	});
}

function isDeadProcessKill(pid) {
	/* This stoped working on MacOs, node v7.2.0 */
	try {
		return process.kill(pid, 0);
	} catch (err) {
		return err.code !== "EPERM";
	}
	return true;
}

function isDeadPsAwk(pid) {
	return child.execSync("ps | awk -e '{ print $1 }'").toString().indexOf(pid) == -1
}

// HACK: determine working dead process check
var isDead = isDeadProcessKill(process.pid) ? isDeadPsAwk : isDeadProcessKill;

/*
	Last retry is always SIGKILL
*/
function terminate(pid, options, _callback) {
	options.signal = options.signal || "SIGTERM";
	options.checkInterval = options.checkInterval || 20;
	options.retryInterval = options.retryInterval || 500;
	options.retryCount = options.retryCount || 5;
	options.timeout = options.timeout || 5000;

	var once = false;
	var callback = function () {
		if (!once) {
			once = true;
			_callback.apply(null, arguments);
		}
	};

	function tryKillParent(pid, callback) {

		function retry(signal) {
			tries++;
			try {
				process.kill(pid, signal);
			} catch (err) {}

			checkDead()
		}

		retry(options.signal);

		var tries = 0;
		function checkDead() {
			var startCheckingDead = Date.now();
			var checkDeadIterval = setInterval(function () {
				if (Date.now() - startCheckingDead > options.retryInterval) {
					clearInterval(checkDeadIterval);
					if (tries < options.retryCount - 1) {
						retry(options.signal);
						checkDead();
					} else if (tries < options.retryCount) {
						checkDead();
					} else {
						var err = new Error("Can't kill process with pid = " + pid);
						callback(err);
					}
				}
				if (isDead(pid)) {
					clearInterval(checkDeadIterval);
					callback();
				}
			}, options.checkInterval);
		}
	}

	function tryKillParentWithChildren(pid, callback) {
		getProcessChildren(pid, function (err, children) {
			tryKillParent(pid, function (err) {
				if (err) { return callback(err); }

				var aliveChildren = children.filter(function (pid) { return !isDead(pid); });
				if (aliveChildren.length) {
					async.forEach(aliveChildren, function (pid, callback) {
						if (!isDead(pid)) {
							tryKillParentWithChildren(pid, callback);
						} else {
							callback();
						}
					}, callback)
				} else {
					callback();
				}
			});
		});
	}

	var timeoutTimeout = setTimeout(function () {
		var err = new Error("Timeout. Can't kill process with pid = " + pid);
		callback(err);
	}, options.timeout);

	tryKillParentWithChildren(pid, callback);
}

function preprocessGlobPatters(patterns) {
	if (!Array.isArray(patterns)) {
		patterns = patterns.split(",");
	}
	var additional = [];
	patterns.forEach(function (p) {
		if (p.startsWith("!") && !p.endsWith("**/*")) {
			if (p.endsWith("/")) {
				additional.push(p+"**/*");
			} else {
				additional.push(p+"/**/*");
			}
		}
	});
	return patterns.concat(additional);
}

function globWithNegates(patterns) {
	var includePatterns = [];
	var excludePatterns = [];

	patterns.forEach(function (p) {
		if (p.startsWith("!") && !p.startsWith("!(")) {
			excludePatterns.push(p.substr(1));
		} else {
			includePatterns.push(p);
		}
	});

	var resultHash = {};
	includePatterns.forEach(function (pattern) {
		if (excludePatterns.length) {
			var options = { ignore: excludePatterns };
		}
		var paths = glob.sync(pattern, options);
		paths.forEach(function (p) {
			resultHash[p] = true;
		});
	});
	return Object.keys(resultHash);
}

var _ruleId = 0;
function ruleId() {
	return _ruleId++;
}

var _watcherId = 0;
function watcherId() {
	return _watcherId++;
}

function Watcher(globs, ruleOptions, cmdOrFun) {
	if (!(this instanceof Watcher)) {
		if (arguments.length === 1) {
			return new Watcher(arguments[0]);
		} else if (arguments.length === 2) {
			return new Watcher(arguments[0], arguments[1]);
		} else {
			return new Watcher(arguments[0], arguments[1], arguments[2]);
		}
	}

	var ruleOptions;
	if (arguments.length === 1) {
		ruleOptions = shallowCopyObj(arguments[0]);
	} else if (arguments.length === 2) {
		ruleOptions = {};
		ruleOptions.globPatterns = arguments[0];
		ruleOptions.cmdOrFun = arguments[1];
	} else {
		ruleOptions = shallowCopyObj(ruleOptions);
		ruleOptions.globPatterns = globs;
		ruleOptions.cmdOrFun = cmdOrFun;
	}

	this._ruleOptions = ruleOptions;
	if (!this._ruleOptions.type) {
		this._ruleOptions.type = "restart";
	}
}

Watcher.prototype._runRestartingChild = function () {
	if (this.getOption("debug")) {
		debugLog(chalk.green("Run"), this._ruleOptions.cmdOrFun.toString());
	}

	this._childRunning = exec(this._ruleOptions.cmdOrFun, {
		writeToConsole: this.getOption("writeToConsole"),
		shell: this.getOption("shell"),
		debug: this.getOption("debug")
	});
	var childRunning = this._childRunning;
	this._childRunning.on("exit", function (code) {
		if (!(childRunning.killed || code === null)) { // not killed
			this._childRunning = null;
			if (this.getOption("restartOnSuccess") && code === 0) {
				this._runRestartingChild();
			}
			if (this.getOption("restartOnError") && code !== 0) {
				this._runRestartingChild();
			}
		} else {
			this._childRunning = null;
		}
	}.bind(this));
};

Watcher.prototype._terminateChild = function (callback) {
	if(!this._isTerminating) {
		if (this.getOption("debug")) {
			debugLog(chalk.green("Terminate"), this._ruleOptions.cmdOrFun.toString().slice(0, 50));
		}
		this._isTerminating = true;
		terminate(this._childRunning.pid, {
			signal: this.getOption("killSignal"),
			checkInterval: this.getOption("killCheckInterval"),
			retryInterval: this.getOption("killRetryInterval"),
			retryCount: this.getOption("killRetryCount"),
			timeout: this.getOption("killTimeout"),
		}, function (err) {
			if (err) {
				console.log(err);
				process.exit(1);
			}
			this._childRunning = null;
			this._isTerminating = false;
			if (callback) { callback(); }
		}.bind(this));
	}
};

Watcher.prototype._restartChild = function () {
	if (this._childRunning) {
		this._terminateChild(function (err) {
			if(err){
				debugLog(chalk.red("Terminating error:"), err.message);
				process.exit(1);
			}
			this._runRestartingChild();
		}.bind(this));
	} else {
		this._runRestartingChild();
	}
};

Watcher.prototype.start = function () {
	if (this._started) {
		throw new Error("Process already started");
	}
	this._watchers = {};

	this._childRunning = null;
	var firstTime = true;
	var execCallback = debounce(function (action, filePath) {
		if (this._ruleOptions.type === "exec") {
			if (typeof(this._ruleOptions.cmdOrFun) === "function") {
				this._ruleOptions.cmdOrFun(filePath, action);
			} else {
				var cwd = path.resolve(".")
				var relFile = filePath;
				var file = path.resolve(filePath);
				var relDir = path.dirname(filePath);
				var dir = path.resolve(path.dirname(filePath));
				var cmd = this._ruleOptions.cmdOrFun
					.replace(new RegExp("\\" + this.getOption("execVariablePrefix") + "cwd", "g"), cwd)
					.replace(new RegExp("\\" + this.getOption("execVariablePrefix") + "relfile", "g"), relFile)
					.replace(new RegExp("\\" + this.getOption("execVariablePrefix") + "file", "g"), file)
					.replace(new RegExp("\\" + this.getOption("execVariablePrefix") + "reldir", "g"), relDir)
					.replace(new RegExp("\\" + this.getOption("execVariablePrefix") + "dir", "g"), dir)
					.replace(new RegExp("\\" + this.getOption("execVariablePrefix") + "action", "g"), action);

				this._childRunning = exec(cmd, {
					writeToConsole: this.getOption("writeToConsole"),
					shell: this.getOption("shell"),
					debug: this.getOption("debug")
				});
				this._childRunning.on("exit", function () {
					this._childRunning = null;
				}.bind(this));
			}
		} else if (this._ruleOptions.type === "restart") {
			this._restartChild();
		}
	}.bind(this), this.getOption("debounce"));
	var reglob = function () {
		var paths = globWithNegates(preprocessGlobPatters(this._ruleOptions.globPatterns));

		paths.forEach(function (p) {
			if (!this._watchers[p]) {
				var rewatch = function () {
					if (this._watchers[p]) {
						if (this.getOption("debug")) {
							debugLog(chalk.red("Deleted")+" watcher: path="+chalk.yellow(p)+" id="+this._watchers[p].id);
						}
						this._watchers[p].close();
					} else {
					}
					try {
						var stat = fs.statSync(p);
						var mtime = stat.mtime;
					} catch (err) {
						return setTimeout(reglob, 0);
					}
					this._watchers[p] = fs.watch(p, function (action) {
						if (this.getOption("debug")) {
							debugLog(chalk.green("Fire")+" watcher: path="+chalk.yellow(p)+" id="+this._watchers[p].id+" action="+action);
						}
						try {
							stat = fs.statSync(p);
						} catch (err) {
							if (err.code == "ENOENT") {
								this._watchers[p].close();
								delete this._watchers[p];
								execCallback("remove", p);
								return;
							}
						}
						if (action == "rename") {
							setTimeout(rewatch, 0);
						}

						if (this.getOption("mtimeCheck")) {
							if (stat.mtime > mtime) {
								execCallback(action, p);
								mtime = stat.mtime;
							}
						} else {
							execCallback(action, p);
						}
					}.bind(this));
					if (this.getOption("debug")) {
						this._watchers[p].id = watcherId();
						debugLog(chalk.green("Created")+" watcher: path="+chalk.yellow(p)+" id="+this._watchers[p].id);
					}
				}.bind(this);

				rewatch();

				if (!firstTime) {
					execCallback("create", p);
				}
			}
		}.bind(this));

		Object.keys(this._watchers).forEach(function (p) {
			if (paths.indexOf(p) == -1) {
				if (this.getOption("debug")) {
					debugLog(chalk.red("Deleted")+" watcher: path="+chalk.yellow(p)+" id="+this._watchers[p].id);
				}
				// catch deletions that happened right after reglob
				if (this._watchers[p]) {
					this._watchers[p].close();
					delete this._watchers[p];
					execCallback("remove", p);
				}
			}
		}.bind(this));

		if (firstTime && this._ruleOptions.type === "restart") {
			this._restartChild();
		}
		firstTime = false;
	}.bind(this);

	reglob();

	this._started = true;
	this._reglobInterval = setInterval(reglob, this.getOption("reglob"));
	return this;
};

Watcher.prototype.options = function () {
	return this._ruleOptions;
}

Watcher.prototype.getOption = function (name) {
	if (this._watcher) {
		return [this._ruleOptions[name], this._watcher._globalOptions[name], defaultOptions[name]].find(function (v) {
			return v != null;
		});
	} else {
		return [this._ruleOptions[name], defaultOptions[name]].find(function (v) {
			return v != null;
		});
	}
};

Watcher.prototype.stop = function () {
	if (this._started) {
		if (this._childRunning) {
			this._terminateChild();
		}
		clearInterval(this._reglobInterval);
		this._reglobInterval = null;
		Object.keys(this._watchers).forEach(function (p) {
			this._watchers[p].close();
			delete this._watchers[p];
		}.bind(this));
		this._started = false;
	}
};

Watcher.prototype.restart = function () {
	this.stop();
	this.start();
};

Watcher.prototype.toJSON = function () {
	var ruleOptionsCopy = JSON.parse(JSON.stringify(this._ruleOptions));
	if (typeof(this._ruleOptions.cmdOrFun) === "function") {
		ruleOptionsCopy.cmdOrFun = "<FUNCTION>";
	}
	ruleOptionsCopy.started = this._started;
	ruleOptionsCopy.id = this.id;
	return ruleOptionsCopy;
};

Watcher.prototype.delete = function () {
	this.stop();
	var index = this._watcher._rules.indexOf(this);
	this._watcher._rules.splice(index, 1);
	if (this.getOption("debug")) {
		debugLog(chalk.green("Delete rule"), "index="+index);
	}
};

function rulesToJSON() {
	return this.map(function (r) {
		return r.toJSON();
	});
}

function PM(globalOptions) {
	if (!(this instanceof PM)) { return new PM(globalOptions); }

	this._globalOptions = globalOptions || {};
	this._rules = [];

	this._rules.toJSON = rulesToJSON;
	this._ruleId = 0;
	this._watcherId = 0;
}

var defaultOptions = {
	debounce: 500, // exec/reload once in ms at max
	reglob: 2000, // perform reglob to watch added files
	//queue: true, // exec calback if it's already executing
	restartOnError: false, // restart if exit code != 0
	restartOnSuccess: false, // restart if exit code == 0
	shell: true, // use this shell for running cmds, or default shell(true)
	//cwd: "path for resolving",
	//persistLog: true, // save logs in files
	//logDir: "./logs",
	//logRotation: "5h", // s,m,h,d,M
	writeToConsole: true, // write logs to console
	mtimeCheck: true,
	debug: false,
	execVariablePrefix: "@",
	killSignal: "SIGTERM",
	killCheckInterval: 20,
	killRetryInterval: 500,
	killRetryCount: 5,
	killTimeout: 5000
};

PM.prototype.getOption = function (name) {
	return [this._globalOptions[name], defaultOptions[name]].find(function (v) {
		return v != null;
	});
};

PM.prototype.addExecRule = function (globPatterns, ruleOptions, cmdOrFun) {
	if (arguments.length === 2) {
		cmdOrFun = arguments[1];
		ruleOptions = {};
	}

	ruleOptions.globPatterns = globPatterns;
	ruleOptions.type = "exec";
	ruleOptions.cmdOrFun = cmdOrFun;

	return this.addRule(ruleOptions);
};

PM.prototype.addRestartRule = function (globPatterns, ruleOptions, cmd) {
	if (arguments.length === 2) {
		cmd = arguments[1];
		ruleOptions = {};
	}

	ruleOptions.globPatterns = globPatterns;
	ruleOptions.type = "restart";
	ruleOptions.cmdOrFun = cmd;

	return this.addRule(ruleOptions);
};

PM.prototype.addRule = function (globs, ruleOptions, cmdOrFun) {
	var rule;
	if(ruleOptions instanceof Watcher){
		rule = arguments[0];
	}else{
		rule = Watcher.apply(null, arguments);
		if (this.getOption("debug")) {
			if (typeof(rule.options().cmdOrFun) === "function") {
				var ruleOptionsCopy = JSON.parse(JSON.stringify(rule.options()));
				ruleOptionsCopy.cmdOrFun = "<FUNCTION>";
			}
			debugLog(chalk.green(".addRule")+"("+JSON.stringify(ruleOptionsCopy || ruleOptions)+")");
		}
		rule.id = ruleId();
	}

	rule._watcher = this;
	this._rules.push(rule);
	return rule;
};

PM.prototype.rules = function () {
	return this._rules;
};

PM.prototype.getRuleById = function (id) {
	return this._rules.find(function (rule) {
		return rule.id === id;
	});
};

PM.prototype.getRuleByIndex = function (index) {
	return this._rules[index];
};

PM.prototype.startById = function (id) {
	var rule = this.getRuleById(id);
	if (!rule) {
		throw { code: "RULE_NOT_FOUND", id: id, message: "Can't start rule with id=" + id + ", there is no such rule" }
	}

	rule.start();
};

PM.prototype.restartById = function (id) {
	var rule = this.getRuleById(id);
	if (!rule) {
		throw { code: "RULE_NOT_FOUND", id: id, message: "Can't restart rule with id=" + id + ", there is no such rule" }
	}

	rule.restart();
};

PM.prototype.stopById = function (id) {
	var rule = this.getRuleById(id);
	if (!rule) {
		throw { code: "RULE_NOT_FOUND", id: id, message: "Can't stop rule with id=" + id + ", there is no such rule" }
	}

	rule.stop();
};

PM.prototype.deleteById = function (id) {
	var rule = this.getRuleById(id);
	if (!rule) {
		throw { code: "RULE_NOT_FOUND", id: id, message: "Can't delete rule with id=" + id + ", there is no such rule" }
	}

	rule.delete();
};

PM.prototype.startAll = function () {
	this._rules.forEach(function (rule) {
		rule.start();
	});
};

PM.prototype.stopAll = function () {
	this._rules.forEach(function (rule) {
		rule.stop();
	});
};

module.exports.PM = PM;
module.exports.Watcher = Watcher;
