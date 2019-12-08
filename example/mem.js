var { Readable, Transform } = require('readable-stream')
var Protocol = require('hypercore-protocol')
var Query = require('../')
var ram = require('random-access-memory')

var hypercore = require('hypercore')
var feed0 = hypercore(ram)

setInterval(function () {
  var n = Math.floor(Math.random()*100)
  feed0.append(String(n))
}, 50)

feed0.ready(function () {
  var feed1 = hypercore(ram, feed0.key)
  var r0 = feed0.replicate(false, { download: false, live: true })
  var r1 = feed1.replicate(true, { sparse: true, live: true })
  r0.pipe(r1).pipe(r0)
  var q0 = new Query({ api: api(feed0) })
  var q1 = new Query({ api: api(feed1) })
  r0.registerExtension('query-example', q0.extension())
  r1.registerExtension('query-example', q1.extension())
  var s = q1.query('subscribe', JSON.stringify({ start: 50, end: 70 }))
  s.pipe(new Transform({
    objectMode: true,
    transform: function (row, enc, next) {
      feed1.update(row.seq, function () {
        feed1.get(row.seq, function (err, buf) {
          if (err) return next(err)
          console.log('n=', Number(buf.toString()))
          next()
        })
      })
    }
  }))
})

function api (feed) {
  var subs = []
  feed.on('append', function () {
    var seq = feed.length
    feed.get(seq, function (err, buf) {
      var n = Number(buf.toString())
      subs.forEach(({ start, end, stream }) => {
        if (n >= start && n < end) {
          stream.push({ key: feed.key, seq })
        }
      })
    })
  })
  return { subscribe }
  function subscribe (args) {
    var { start, end } = JSON.parse(args.toString())
    var stream = new Readable({
      objectMode: true,
      read: function () {}
    })
    subs.push({ start, end, stream })
    return stream
  }
}
