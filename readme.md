# hypercore-query-extension

ask peers over an extension for which sequences in which feeds are relevant to
custom query logic

This approach is very useful for sparse data from a potentially large number of
feeds. Instead of downloading everything for each feed, you can ask peers which
feeds and sequences are relevant to particular queries. For example, if you have
a chat application, you might ask peers about the latest 20 messages in a
channel.

# example

This example builds a feed and a clone of that feed in memory. The feed is
populated with a number between 0 and 99, inclusive every 50 milliseconds. The
clone feed is opened in sparse mode and the clone tells the main feed through
the query extension that it is only interested in numbers between 50 and 70,
inclusive. The clone then downloads only those sequences that were mentioned in
the query results.

``` js
var Query = require('hypercore-query-extension')
var { Readable, Transform } = require('readable-stream')
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
      if (!row.key.equals(feed0.key)) return next()
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
        if (n >= start && n <= end) {
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
```

# api

``` js
var Query = require('hypercore-query-extension')
```

## var q = Query(opts)

Create a new `Query` instance `q` from:

* `opts.api` -

## q.extension()

Return a function that can be passed to `feed.registerExtension()` or
`proto.registerExtension()`. You'll almost always want to do:

``` js
feed.registerExtension('your-extension-name', q.extension())
// or:
proto.registerExtension('your-extension-name', q.extension())
```

## var stream = q.query(name, data)

Return a readable objectMode `stream` with results from calling the api endpoint
`name` with an optional `data` payload (as a `Buffer`).

Each `row` from the readable stream contains:

* `row.key` - feed key (`Buffer`)
* `row.seq` - feed sequence number

# license

BSD
