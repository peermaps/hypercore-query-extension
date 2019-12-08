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

var umkvl = require('unordered-materialized-kv-live')
var db = require('level')(path.join(argv.datadir,'db'))
var kv = umkvl(db)

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
    if (err) return console.error(err)
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
  kv.open(argv._.slice(1))
  kv.on('value', function (key, ids) {
    ids.forEach(function (id) {
      var [key,seq] = id.split('@')
      storage.getOrCreateRemote(key, { valueEncoding: 'json' }, function (err, feed) {
        feed.get(Number(seq), { valueEncoding: 'json' }, function (err, doc) {
          console.log(`${id} ${doc.key} => ${doc.value}`)
        })
      })
    })
  })
  connect(function (r, q) {
    var s = q.query('get', Buffer.from(argv._[1]))
    s.pipe(to.obj(function (row, enc, next) {
      storage.getOrCreateRemote(row.key, function (err, feed) {
        if (err) return next(err)
        if (feed.has(row.seq)) return
        r.open(row.key, { live: true, sparse: true })
        feed.update(row.seq+1, function () {
          feed.get(row.seq, { valueEncoding: 'json' }, function (err, doc) {
            if (err) return next(err)
            var kdoc = {
              id: row.key.toString('hex') + '@' + row.seq,
              key: doc.key,
              links: doc.links || []
            }
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
    var q = new Query({ api: { get } })
    function get (data) {
      kv.open(data)

      var r = new Readable({
        objectMode: true,
        read: function () {
          kv.get(data, function (err, ids) {
            if (err) return r.emit('error', err)
            ids.forEach(function (id) {
              var [key,seq] = id.split('@')
              r.push({
                key: Buffer.from(key,'hex'),
                seq: Number(seq)
              })
            })
            r.push(null)
          })
        }
      })
      return r
    }
    q.register(p, 'kv')
    var r = new Replicate(storage, p, { live: true, sparse: true })
    pump(stream, p, stream)
    if (f) f(r, q)
  })
}
