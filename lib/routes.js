var _ = require('lodash')
  , _s = require('underscore.string')
  , async = require('async')
  , dotty = require('dotty')
  , passport = require('passport')
  , passwordHash = require('password-hash')
  , tok = require('tok');

module.exports = function (app, options) {
  var util = require('./util')(options);

  var findUserId = function (req, user, callback) {
    var model = req.getModel()
      , found = null;

    async.some(options.keys, function (key, callback) {
      var path = key.split('.')
        , val = dotty.get(user, path)
        , verify = dotty.get(options.schema, key + '.verify')
        , coll = util.getUserCollection(path.shift())
        , doc = path.join('.')
        , target = {$query: {}};

      target.$query[doc] = val;
      if (verify) target.$query[util.getUserPath(verify)] = true;
      var query = model.query(coll, target);

      model.fetch(query, function (err) {
        if (err) return callback(err);
        var userId = dotty.get(query.get(), '0.id');
        if (userId) found = userId;
        callback(userId);
      });
    }, function (userId) {
      callback(null, found);
    });
  };

  var saveUserSession = function (req, user) {
    var model = req.getModel();
    dotty.put(req.session, options.session.path + '.id', user.id);
    model.set('_session.' + options.session.path + '.id', user.id);
    model.set('_session.' + options.session.path + '.registered', user.registered);
  };

  var updateUser = function (req, user, callback) {
    var model = req.getModel();

    async.each(options.accessLevels, function (lvl, callback) {
      var $user = model.at(util.getUserCollection(lvl) + '.' + user.id);

      $user.fetch(function (err) {
        if (err) return callback(err);
        var obj = _.merge($user.get(), user[lvl]);
        $user.set(obj);
        user.registered = obj.registered
        callback();
      });
    }, callback);
  };

  _.each(options.providers.strategies, function (strategy, name) {
    app.get(strategy.options.url, passport.authenticate(name, strategy.options));

    app.get(strategy.callback.url, passport.authenticate(name, strategy.callback), function (req, res) {
      if (!strategy.callback.popup) return res.redirect('/');

      var model = req.getModel()
        , sessionPath = options.session.path
        , userId = model.get('_session.' + options.session.path + '.id')
        , tmpl = options.providers.callbackTemplate
        , html = tmpl({sessionPath: sessionPath, userId: userId});

      res.send(html);
    });
  });

  app.post(options.routes.forgot.url, function (req, res) {
    var model = req.getModel()
      , body = util.parseBody(req.body)
      , user = body.user
      , method = dotty.get(body, 'options.method') || ''
      , verify = dotty.get(options.schema, method + '.verify');

    if (!method) return util.sendError(400, 'method missing');

    findUserId(req, body.user, function (err, userId) {
      if (err) return util.sendError(res, 500, err);
      if (!userId) return util.sendError(res, 404, 'user not found');
      if (!options.routes.forgot.handler) return res.send(res, 500, 'no forgot handler');

      var $user = model.at(util.getUserCollection(verify) + '.' + userId)
        , Tok = tok({secretKey: options.secretKey});

      $user.fetch(function (err) {
        if (err) return util.sendError(res, 500, err);
        if (!!verify && !$user.get(util.getUserPath(verify))) return util.sendError(res, 400, 'not verified');

        Tok.create(userId, null, function (err, token) {
          if (err) return util.sendError(res, 500, err);
          options.routes.forgot.handler(req, method, userId, token, function (code, err) {
            if (!code) return res.send();
            util.sendError(res, code, err);
          });
        });
      });
    });
  });

  app.post(options.routes.change.url, function (req, res) {
    var model = req.getModel()
      , body = util.parseBody(req.body)
      , user = util.schemify(body.user);

    user.id = dotty.get(req.session, options.session.path + '.id');

    updateUser(req, user, function (err) {
      if (err) return util.sendError(res, 500, err);
      res.send(_.pick(user, 'id', 'registered'));
    });
  });

  app.post(options.routes.reset.url, function (req, res) {
    var model = req.getModel()
      , body = util.parseBody(req.body)
      , user = util.schemify(body.user)
      , token = body.token
      , Tok = tok({secretKey: options.secretKey});

    if (!token) return util.sendError(res, 400, 'token missing');
    if (!user.id) return util.sendError(res, 400, 'no user id');

    try {
      token = JSON.parse(token);
    } catch (e) {
      return util.sendError(res, 400, 'token invalid json');
    }

    Tok.check(user.id, token, function (err) {
      if (err) return util.sendError(res, 400, err);
      updateUser(req, user, function (err) {
        if (err) return util.sendError(res, 400, err);
        saveUserSession(req, user);
        res.send(_.pick(user, 'id', 'registered'));
      });
    });
  });

  app.post(options.routes.signIn.url, function (req, res) {
    var model = req.getModel()
      , body = util.parseBody(req.body)
      , keys = util.parseBodyKeys(req.body)
      , user = _.merge(options.skeleton, body.user)
      , containsPassword = false
      , errorCode = 500;

    findUserId(req, user, function (err, userId) {
      if (err) return util.sendError(res, 500, err);
      if (!userId) return util.sendError(res, 404, 'user not found');
      if (!util.userContainsType(user, 'password')) return util.sendError('passwording missing');
      user.id = userId;

      async.each(keys, function (key, callback) {
        key = key.split('.').slice(1).join('.');

        var path = key.split('.')
          , coll = util.getUserCollection(path.shift())
          , type = dotty.get(options.schema, key + '.type')
          , $user = model.at(coll + '.' + user.id);

        if (!type) return callback();
        if (type !== 'password') return callback();

        $user.fetch(function (err) {
          if (err) return callback(err);
          user.registered = $user.get('registered');

          var hash = dotty.get(options.schema, key + '.hash')
            , dbPass = $user.get(path.join('.'))
            , pass = dotty.get(user, key)
            , ok = hash ? passwordHash.verify(pass, dbPass) : pass === dbPass;

          if (!ok) errorCode = 400;
          callback(ok ? null : 'invalid password');
        });
      }, function (err) {
        if (err) return util.sendError(res, errorCode, err);
        saveUserSession(req, user);
        res.send(_.pick(user, 'id', 'registered'));
      });
    });
  });

  app.post(options.routes.signOut.url, function (req, res) {
    var model = req.getModel()
      , userId = dotty.get(req.session, options.session.path + '.id')
      , $user = model.at(util.getUserCollection() + '.' + userId);

    $user.fetch(function (err) {
      if (err) return util.sendError(res, 500, err);
      if (!$user.get('registered')) return util.sendError(res, 400, 'not signed in');
      var user = {id: model.id(), registered: false};

      _.each(options.accessLevels, function (lvl) {
        model.add(util.getUserCollection(lvl), user);
      });

      saveUserSession(req, user);
      return res.send(_.pick(user, 'id'));
    });
  });

  app.post(options.routes.signUp.url, function (req, res) {
    var model = req.getModel()
      , body = util.parseBody(req.body)
      , user = body.user;

    if (!user) return util.sendError(res, 400, 'missing user');
    if (!util.userContainsType(user, 'password')) return util.sendError(res, 400, 'missing password');
    user = util.schemify(_.merge(options.skeleton, body.user));
    user.id = dotty.get(req.session, options.session.path + '.id');

    findUserId(req, user, function (err, foundUserId) {
      if (foundUserId) return util.sendError(res, 400, 'user exists');

      _.each(options.accessLevels, function (lvl) {
        user[lvl].registered = true;
      });

      updateUser(req, user, function (err) {
        if (err) return util.sendError(res, 500, err);
        return res.send(_.pick(user, 'id'));
      });
    });
  });

  return function (req, res, next) {
    next();
  };
};