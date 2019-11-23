var minimist = require('minimist')
var argv = minimist(process.argv.slice(2), {
  alias: { d: 'datadir' }
})
var pump = require('pump')
var to = require('to2')
var path = require('path')
var { Readable } = require('readable-stream')

var Protocol = require('hypercore-protocol')
var swarm = require('discovery-swarm')

var umkv = require('unordered-materialized-kv')
var db = require('level')(path.join(argv.datadir,'db'))
var kv = umkv(db)

var raf = require('random-access-file')
var Storage = require('multifeed-storage')
var storage = new Storage(function (name) {
  return raf(path.join(argv.datadir,name))
})
var Replicate = require('multifeed-replicate')
var Query = require('../')

if (argv._[0] === 'put') {
  var doc = {
    key: argv._[1],
    value: argv._[2],
    links: [].concat(argv.link || [])
  }
  storage.getOrCreateLocal('feed', { valueEncoding: 'json' }, function (err, feed) {
    feed.append(doc, function (err, seq) {
      if (err) console.error(err)
      var kdoc = {
        id: feed.key.toString('hex') + '@' + seq,
        key: doc.key,
        links: doc.links
      }
      kv.batch([kdoc], function (err) {
        if (err) console.error(err)
      })
    })
  })
} else if (argv._[0] === 'get') {
  kv.get(argv._[1], function (err, ids) {
    ;(ids || []).forEach(function (id) {
      var [key,seq] = id.split('@')
      storage.getOrCreateRemote(key, { valueEncoding: 'json' }, function (err, feed) {
        feed.get(Number(seq), function (err, doc) {
          console.log(`${id} ${doc.key} => ${doc.value}`)
        })
      })
    })
  })
  connect(function (q) {
    var s = q.query('get', Buffer.from(argv._[1]))
    s.pipe(to.obj(function (row, enc, next) {
      console.log('QUERY',row)
      storage.getOrCreateRemote(row.key, function (err, feed) {
        if (err) return next(err)
        feed.update(row.seq+1, function () {
          feed.get(row.seq, function (err, doc) {
            if (err) return next(err)
            var kdoc = {
              id: msg.feed + '@' + msg.seq,
              key: doc.key,
              links: doc.links || []
            }
            console.log(`${msg.feed}@${msg.seq} ${doc.key} => ${doc.value}`)
            kv.batch([kdoc], next)
          })
        })
      })
    }))
  })
} else if (argv._[0] === 'connect') {
  connect()
}

function connect (f) {
  var sw = swarm()
  sw.join(argv.swarm)
  sw.on('connection', function (stream, info) {
    var p = new Protocol(info.initiator, {
      download: false,
      live: true
    })
    var q = new Query(storage, { api: { get } })
    function get (data) {
      var r = new Readable({
        objectMode: true,
        read: function () {
          // todo: toString?
          kv.get(data, function (err, ids) {
            if (err) return r.emit('error', err)
            ids.forEach(function (id) {
              var [key,seq] = id.split('@')
              r.push({ key, seq })
            })
            r.push(null)
          })
        }
      })
      return r
    }
    q.register(p, 'kv')
    var r = new Replicate(storage, p)
    pump(stream, p, stream)
    if (f) f(q)
  })
}
