var minimist = require('minimist')
var argv = minimist(process.argv.slice(2), {
  alias: { d: 'datadir' }
})
var path = require('path')
var pump = require('pump')
var feeds = {}

var Protocol = require('hypercore-protocol')
var swarm = require('discovery-swarm')
var hypercore = require('hypercore')

var feed = hypercore(path.join(argv.datadir,'core'), { valueEncoding: 'json' })
var umkv = require('unordered-materialized-kv')
var db = require('level')(path.join(argv.datadir,'db'))
var kv = umkv(db)

if (argv._[0] === 'put') {
  var doc = {
    key: argv._[1],
    value: argv._[2],
    links: [].concat(argv.link || [])
  }
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
} else if (argv._[0] === 'get') {
  kv.get(argv._[1], function (err, ids) {
    ;(ids || []).forEach(function (id) {
      var [key,seq] = id.split('@')
      var rfeed = open(Buffer.from(key,'hex'))
      rfeed.get(Number(seq), function (err, doc) {
        console.log(`${id} ${doc.key} => ${doc.value}`)
      })
    })
  })
  connect(function (ext) {
    ext.send({ type: 'get', key: argv._[1] })
  })
} else if (argv._[0] === 'connect') {
  connect()
}

function connect (f) {
  var sw = swarm()
  sw.join(argv.swarm)
  sw.on('connection', function (stream, info) {
    var p = new Protocol(info.initiator, {
      ondiscoverykey: function (dkey) {
        if (dkey.equals(feed.discoveryKey)) {
          feed.replicate(info.initiator, {
            download: false,
            live: true,
            stream: p
          })
        } else {
          getKey(dkey, function (err, key) {
            if (err) return console.error(err)
            if (!opened[key]) {
              opened[key] = true
              var rfeed = open(Buffer.from(key,'hex'))
              rfeed.replicate(info.initiator, {
                download: false,
                live: true,
                stream: p
              })
            }
          })
        }
      }
    })
    var opened = {}
    var ext = p.registerExtension('kv', {
      encoding: 'json',
      onmessage: function (msg) {
        console.log('MSG', JSON.stringify(msg))
        if (msg.type === 'get') {
          kv.get(msg.key, function (err, ids) {
            if (err) return console.error(err)
            ids.forEach(function (id) {
              var [key,seq] = id.split('@')
              ext.send({
                type: 'response',
                feed: key,
                seq: Number(seq)
              })
            })
          })
        } else if (msg.type === 'response') {
          if (!opened[msg.feed]) {
            opened[msg.feed] = true
            var bkey = Buffer.from(msg.feed,'hex')
            var rfeed = open(bkey)
            rfeed.replicate(info.initiator, {
              live: true,
              sparse: true,
              stream: p
            })
          } else {
            var rfeed = open(bkey)
          }
          rfeed.update(msg.seq+1, function () {
            rfeed.get(msg.seq, function (err, doc) {
              var kdoc = {
                id: msg.feed + '@' + msg.seq,
                key: doc.key,
                links: doc.links || []
              }
              console.log(`${msg.feed}@${msg.seq} ${doc.key} => ${doc.value}`)
              kv.batch([kdoc], function (err) {
                if (err) console.error(err)
              })
            })
          })
        }
      }
    })
    pump(stream, p, stream)
    if (f) f(ext)
  })
}

function open (key) {
  var hkey = key.toString('hex')
  if (!feeds[hkey]) {
    var d = path.join(argv.datadir,key.toString('hex'))
    feeds[hkey] = hypercore(d, key, { valueEncoding: 'json' })
    var dkey = feeds[hkey].discoveryKey.toString('hex')
    db.put('dkey!' + dkey, hkey, function (err) {
      if (err) console.error(err)
    })
  }
  return feeds[hkey]
}

function getKey (dkey, cb) {
  var keys = Object.keys(feeds)
  for (var i = 0; i < keys.length; i++) {
    if (feeds[keys[i]].discoveryKey.equals(dkey)) {
      return process.nextTick(cb, null, keys[i])
    }
  }
  db.get('dkey!' + dkey.toString('hex'), cb)
}
