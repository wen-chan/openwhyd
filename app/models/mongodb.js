/**
 * mongodb model
 * wraps a accessor to collections of a mongodb database
 * @author adrienjoly, whyd
 **/

// GLOBAL.DEBUG = false; // deprecated and not needed
var fs = require('fs');
var mongodb = require('mongodb');
var async = require('async');
var shellRunner = require('./mongodb-shell-runner.js');
var userModel = null; //require("./user.js");

const DB_INIT_SCRIPT = './config/initdb.js';
const DB_TEST_SCRIPT = './config/initdb_testing.js';

exports.isObjectId = function(i) {
  //return isNaN(i);
  return ('' + i).length == 24;
};

var USER_CACHE_FIELDS = {
  _id: 1,
  fbId: 1,
  name: 1,
  img: 1,
  email: 1,
  digest: 1,
  iBy: 1,
  handle: 1,
  pref: 1, // needed by mainTemplate
  lastFm: 1 // needed by mainTemplate
};

exports.collections = {};
exports.usernames = {};

exports.ObjectID = mongodb.ObjectID; //exports.ObjectID = require('bson').BSONPure.ObjectID;

exports.ObjectId = function(v) {
  try {
    return exports.ObjectID.createFromHexString('' + v);
  } catch (e) {
    console.warn('invalid mongodb object id:' + v);
    return 'invalid_id';
  }
};

// http://www.mongodb.org/display/DOCS/Object+IDs#ObjectIDs-DocumentTimestamps
exports.dateToHexObjectId = function(t) {
  var t = Math.round(t.getTime() / 1000); // turn into seconds
  t = t.toString(16); // translate into hexadecimal representation
  t = t + '0000000000000000'; // add null values for 8 other bytes
  while (
    t.length <
    2 * 12 // pad with leading zeroes, to reach 12 bytes
  )
    t = '0' + t;
  return t;
};

// other way around: _id.getTimestamp() // _id.generationTime IS DEPRECATED;

exports.getUserFromId = function(uid) {
  return exports.usernames['' + uid];
};

exports.getUserNameFromId = function(uid) {
  return (exports.usernames['' + uid] || {}).name;
};

exports.getPublicProfileFromId = function(uid) {
  var user = exports.usernames['' + uid];
  return !user
    ? undefined
    : {
        _id: user._id,
        name: user.name
      };
};

exports.cacheUser = function(user) {
  if (!user) return console.log('WARNING: trying to cache a null user!');
  user.id = '' + (user._id || user.id);
  //console.log("Caching user: ", user);
  exports.usernames[user.id] = exports.usernames[user.id] || {};
  exports.usernames[user.id].id = user.id;
  for (var i in user)
    if (USER_CACHE_FIELDS[i])
      exports.usernames[user.id][i] = user[i] || exports.usernames[user.id][i];
};

exports.cacheUsers = function(callback) {
  console.log('Caching users ...');
  userModel = userModel || require('./user.js');
  userModel.fetchMulti({}, { fields: USER_CACHE_FIELDS }, function(results) {
    for (var i in results) exports.cacheUser(results[i]);
    console.log('Caching users: done!');
    if (callback) callback();
  });
};

exports.forEach = function(colName, params, handler, cb, cbParam) {
  var q = {};
  params = params || {};
  if (!params.batchSize) params.batchSize = 1000;
  if (params.q) {
    q = params.q;
    delete params.q;
  }
  exports.collections[colName].find(q, params, function(err, cursor) {
    cursor.each(function(err, item) {
      if (item) handler(item);
      else if (cb) cb(cbParam);
    });
  });
};

// handler is responsible for calling the provided "next" function
exports.forEach2 = function(colName, params, handler) {
  var q = {};
  params = params || {};
  if (!params.batchSize) params.batchSize = 100;
  if (params.q) {
    q = params.q;
    delete params.q;
  }
  if (params.after != null && exports.isObjectId(params.after))
    q._id = { $lt: exports.ObjectId('' + params.after) };
  exports.collections[colName].find(q, params, function(err, cursor) {
    (function next() {
      cursor.nextObject(function(err, item) {
        if (err) {
          console.error('mongodb.forEach2 ERROR', err);
          handler({ error: err });
        } else handler(item, item ? next : undefined);
      });
    })();
  });
};

exports.cacheCollections = function(callback) {
  function finishInit() {
    console.log('MongoDB model is now ready for queries!');
    callback.call(module.exports, null, exports._db);
  }
  // diagnostics and collection caching
  exports._db.collections(function(err, collections) {
    if (err) console.log('MongoDB Error : ' + err);
    else {
      if (0 == collections.length) finishInit();
      var remaining = collections.length;
      for (var i in collections) {
        var queryHandler = (function() {
          var table = collections[i].collectionName;
          return function(err, result) {
            console.log(' - found table: ' + table + ' : ' + result + ' rows');
            exports._db.collection(table, function(err, col) {
              exports.collections[table] = col;
              if (0 == --remaining) finishInit();
            });
          };
        })();
        collections[i].count(queryHandler);
      }
    }
  });
};

// this method runs the commands of a mongo shell script (e.g. initdb.js)
exports.runShellScript = function(script, callback) {
  return shellRunner.runScriptOnDatabase(script, exports._db, callback);
};

exports.clearCollections = async function() {
  if (process.appParams.mongoDbDatabase !== 'openwhyd_test') {
    return reject(new Error('allowed on test database only'));
  } else {
    for (const name in exports.collections) {
      await exports.collections[name].remove({}, { multi: true });
    }
  }
};

exports.initCollections = function({ addTestData } = {}) {
  return new Promise(async (resolve, reject) => {
    const dbInitScripts = [DB_INIT_SCRIPT];
    if (addTestData) {
      if (process.appParams.mongoDbDatabase !== 'openwhyd_test') {
        return reject(new Error('allowed on test database only'));
      } else {
        dbInitScripts.push(DB_TEST_SCRIPT); // will create the admin user + some fake data for automated tests
      }
    }
    async.eachSeries(
      dbInitScripts,
      function(initScript, nextScript) {
        console.log('Applying db init script:', initScript, '...');
        exports.runShellScript(fs.readFileSync(initScript), function(err) {
          if (err) throw err;
          nextScript();
        });
      },
      function(err, res) {
        // all db init scripts were interpreted => continue app init
        exports.cacheCollections(function() {
          exports.cacheUsers(function() {
            resolve();
          });
        });
      }
    );
  });
};

exports.init = function(readyCallback) {
  var dbName = process.appParams.mongoDbDatabase;
  var host = process.appParams.mongoDbHost;
  var port = process.appParams.mongoDbPort;
  var authUser = process.appParams.mongoDbAuthUser;
  var authPassword = process.appParams.mongoDbAuthPassword;

  var authStr = '';
  if (authUser && authPassword) authStr = authUser + ':' + authPassword + '@';

  var url = 'mongodb://' + authStr + host + ':' + port + '/' + dbName; // + "?w=1";

  console.log('Connecting to ' + url + '...');

  var options = {
    native_parser: true,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    //strict: false,
    //safe: false,
    w: 'majority' // write concern: (value of > -1 or the string 'majority'), where < 1 means no write acknowlegement
  };

  //var dbserver = new mongodb.Server(host, port, {auto_reconnect:true});
  //var db = new mongodb.Db(dbName, dbserver, options);

  mongodb.MongoClient.connect(url, options, function(err, client) {
    if (err) throw err;

    exports._db = client.db(dbName);

    exports._db.addListener('error', function(e) {
      console.log('MongoDB model async error: ', e);
    });

    console.log('Successfully connected to ' + url);
    readyCallback.call(module.exports, null, exports._db);
  });
};
