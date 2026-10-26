# relay

Stream to YouTube and Twitch at once while uploading only once. OBS sends a
single stream to your server, and the relay sends it on to both: to YouTube
untouched, at whatever quality you stream in, and to Twitch scaled down to
what Twitch takes. Other platforms, such as Kick, can be added too.

It's useful when your upload can carry one high-quality stream but not two,
or when you want YouTube to get more than Twitch allows (say 1440p at
16 Mb/s on YouTube, 1080p at 6 Mb/s on Twitch).

## How it works

```
OBS ──RTMP or SRT──▶ MediaMTX ──▶ relay (FFmpeg) ──┬──▶ YouTube   copied as it comes in
               1936 / 8890 (UDP)                   └──▶ Twitch    scaled and re-encoded
```

- **[MediaMTX](https://github.com/bluenviron/mediamtx)** takes the stream from
  OBS, but only with the right password, so nobody else can stream to your
  channels through it.
- **The relay** waits until a stream comes in, then runs one FFmpeg per
  platform to send it on. YouTube gets a straight copy, which costs almost no
  CPU. Twitch gets its own encode at the resolution and bitrate you set, with a
  keyframe every 2 seconds whatever your frame rate. When the stream ends, the
  relay waits for the next one by itself.
- If one platform fails, say Twitch turns the key away or its server drops
  out, the others keep going. The relay tries that platform again after 2
  seconds, then waits twice as long each time it fails in a row, up to 30
  seconds. One that sends no frames for 15 seconds counts as failed too,
  since FFmpeg can hang rather than give up when a server goes away.
- Stream keys are hidden in everything it logs, since FFmpeg prints its full
  addresses.

## What you need

- A server with Docker and Docker Compose, with port **1936** (TCP) reachable
  from where you stream, and **8890** (UDP) too if you stream by SRT.
- Enough CPU there for one x264 encode (the `superfast` preset) for each
  platform that's re-encoded, as Twitch is in `.env.example`. Platforms sent
  the stream as it comes in, as YouTube is, cost almost nothing.

## Setting it up

```bash
git clone https://github.com/CuteNikki/relay.git
cd relay
cp .env.example .env
```

Fill in `.env`:

- **`INBOUND_STREAM_KEY`**: a password you make up, which OBS streams with.
  Stick to letters, digits and `_`.
- **`OUTPUT_1_KEY`** and/or **`OUTPUT_2_KEY`**: your YouTube and Twitch
  stream keys. A platform without a key is left out. For other platforms, see
  [Where it sends](#where-it-sends).

Then start it:

```bash
docker compose up -d --build
```

## Setting up OBS

OBS can stream to the relay by RTMP or by SRT. RTMP is the usual way. SRT
copes better with a connection that drops packets, as over Wi-Fi or mobile
data or far from the server: it sends again only what went missing, within a
buffer of a second or two, where RTMP slows the whole stream down to catch up,
and OBS drops frames. It also needs port 8890 open for UDP, which some
networks block.

### By RTMP

In **Settings > Stream**:

| Setting    | Value                                                 |
| ---------- | ----------------------------------------------------- |
| Service    | Custom…                                               |
| Server     | `rtmp://your-server:1936`                             |
| Stream key | `live?user=relay&pass=` and your `INBOUND_STREAM_KEY` |

For example, with `INBOUND_STREAM_KEY=hunter2` the stream key is
`live?user=relay&pass=hunter2`.

### By SRT

In **Settings > Stream**, choose **Custom…**, leave the stream key empty, and
put all of this in **Server**, with your `INBOUND_STREAM_KEY` after
`relay:`:

```
srt://your-server:8890?streamid=publish:live:relay:hunter2&latency=2000000&pkt_size=1316
```

`latency` is the buffer, in microseconds: `2000000` is 2 seconds. A steady
connection can do with less, a shaky one may need more; about four times your
ping to the server is a fair start. The platforms' own delay is longer anyway.

To have it encrypted on the way to your server, set `SRT_PASSPHRASE` in
`.env` and add `&passphrase=` and the same passphrase to the end of the
address. With a passphrase set, OBS can't stream by SRT without it, while
RTMP is never encrypted.

### Either way

In **Settings > Output**, stream at the quality you want YouTube to get, since
YouTube receives exactly what OBS sends. Set the keyframe interval to 2
seconds, as YouTube asks.

## Settings

All in `.env`:

| Setting              | Default                  | What it's for                                                                     |
| -------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `INBOUND_STREAM_KEY` | (required)               | The password OBS streams with                                                     |
| `OUTPUT_n_…`         |                          | Where it sends (see [Where it sends](#where-it-sends))                            |
| `STATUS_FILE`        | `/tmp/relay/status.json` | Where it writes whether it's live (see below)                                     |
| `LOG_LEVEL`          | `info`                   | How much it logs: `debug` (everything FFmpeg says too), `info`, `warn` or `error` |
| `SRT_PASSPHRASE`     | (none)                   | Encrypts what OBS sends by SRT: 10 to 79 characters, or MediaMTX won't start      |
| `RECORD`             | `false`                  | `true` records what comes in to `./recordings` (see below)                        |
| `RECORD_KEEP`        | `7d`                     | How long recordings are kept, as `7d`, `12h` or `30m`; `0s` keeps them for good   |

## Where it sends

Each platform is an output in `.env`, numbered from 1. `.env.example` starts
you off with YouTube and Twitch:

```bash
OUTPUT_1_NAME=YouTube
OUTPUT_1_URL=rtmp://a.rtmp.youtube.com/live2
OUTPUT_1_KEY=…

OUTPUT_2_NAME=Twitch
OUTPUT_2_URL=rtmp://live.twitch.tv/app
OUTPUT_2_KEY=…
OUTPUT_2_RESOLUTION=1920x1080
OUTPUT_2_BITRATE=6000k
```

Any other platform that takes RTMP or RTMPS, such as Kick, is another output,
`OUTPUT_3_…`, with the address and key from its dashboard.

| Setting               | What it's for                                                                    |
| --------------------- | -------------------------------------------------------------------------------- |
| `OUTPUT_n_NAME`       | What it's called in the logs and the status; `Output n` if left out              |
| `OUTPUT_n_URL`        | The server address the platform gives you, `rtmp://` or `rtmps://` (required)    |
| `OUTPUT_n_KEY`        | Its stream key; an output without one is left out                                |
| `OUTPUT_n_RESOLUTION` | Re-encodes it at this size, such as `1280x720`                                   |
| `OUTPUT_n_BITRATE`    | Re-encodes it at this video bitrate, such as `4000k`; `6000k` if only a size set |
| `OUTPUT_n_PRESET`     | Re-encodes it with this x264 preset, `superfast` unless set (see below)          |

Without a resolution, bitrate or preset, an output gets the stream as it
comes in, like YouTube above, which costs almost no CPU. With any of them, it
gets an encode of its own, like Twitch, which costs one x264 encode's worth.
Twitch has servers nearer you than its default, in
[Twitch's list](https://help.twitch.tv/s/twitch-ingest-recommendation).

The preset trades CPU for picture: from `ultrafast`, `superfast`, `veryfast`,
`faster`, `fast` and `medium` to `slow`, `slower` and `veryslow`, each takes
more CPU than the one before and looks better at the same bitrate.
`superfast` is light; `veryfast`, what OBS uses, looks better for about twice
the CPU. If an output's `speed` in the status falls below `1x` while
streaming, its preset is too slow for the server.

Give each output its own name. Numbers needn't run on: `OUTPUT_1` and
`OUTPUT_5` are fine. A setting the relay doesn't know, such as a misspelt
`OUTPUT_1_BITRAT`, stops it with an error rather than being left out without a
word.

Before outputs, YouTube and Twitch had settings of their own:
`YOUTUBE_STREAM_KEY`, `TWITCH_STREAM_KEY`, `TWITCH_RESOLUTION` and so on. The
relay won't start with those in `.env`, and says which they are, so move them
to outputs as above.

## Recording

With `RECORD=true` in `.env`, MediaMTX keeps a copy of what OBS sends, at full
quality, in `recordings/live/` next to the compose file. It's a file an hour,
named for when it started in UTC, such as `2026-10-26_13-55-24Z.mp4`. It's
written a second at a time, so if the server goes down, only the last second
is lost. That way you have the stream even if a platform's copy fails.

Recordings take room: a 16 Mb/s stream is about 7 GB an hour. MediaMTX
deletes them after `RECORD_KEEP`, 7 days unless you set it. It doesn't watch
how full the disk is, so set it to what your disk can hold.

MediaMTX runs as root in its container, so the files belong to root. To delete
them yourself, use `sudo rm`.

After changing `RECORD` or `RECORD_KEEP`, run `docker compose up -d` again.

## Is it live?

While it runs, the relay keeps a small JSON file up to date with whether a
stream is coming in, what it is, and how the relay is keeping up:

```json
{
  "live": true,
  "since": 1792700000000,
  "input": {
    "video": "h264, 2560x1440, 60 fps",
    "audio": "aac, 48000 Hz, stereo"
  },
  "fps": 60,
  "bitrate": "16000.2kbits/s",
  "speed": "1x",
  "droppedFrames": 0,
  "outputs": [
    {
      "name": "YouTube",
      "sends": "as it comes in",
      "state": "live",
      "since": 1792700001000,
      "bitrate": "16000.2kbits/s",
      "speed": "1x",
      "droppedFrames": 0,
      "retries": 0
    },
    {
      "name": "Twitch",
      "sends": "1080p at 6000 kb/s",
      "state": "retrying",
      "retries": 2,
      "lastError": "RTMP_Connect0, failed to connect socket. 111 (Connection refused)"
    }
  ],
  "problems": [],
  "updatedAt": 1792700002000
}
```

Each output's `state` is `waiting` (no stream), `connecting`, `live` or
`retrying` (it failed and will try again). `retries` counts its restarts
during this stream, and `lastError` is why it last failed. Its `fps`,
`bitrate` and `speed` cover the last couple of seconds, not the whole time
since it started, so a drop shows straight away.

The `fps`, `bitrate`, `speed` and `droppedFrames` at the top cover the outputs
that are live: bitrates and dropped frames added up, frame rate and speed from
the slowest. A `speed` below `1x` means it's falling behind. `problems` lists
what's wrong with the relay as a whole, such as MediaMTX turning its password
away; a platform failing shows in its output instead.

A dashboard can read the file with
`docker exec rtmp-relay cat /tmp/relay/status.json`. The compose file labels
the container `dash.app: relay` for [dash](https://github.com/CuteNikki/dash),
which shows this on its tile.

Docker checks the relay's health from the same file: `docker ps` shows it as
`unhealthy` if the file stops being written, which means the relay has hung,
or if `problems` isn't empty. `docker inspect rtmp-relay` says why.

To follow along as it streams:

```bash
docker compose logs -f rtmp-relay
```

Each line says when, how much it matters (`INFO`, `WARN`, `ERROR`) and which
platform it's about, if one. A platform failing shows as a warning with
FFmpeg's reason, such as `Connection refused`. FFmpeg's own chatter is left to
`LOG_LEVEL=debug`, and a line it repeats is printed once a minute with a count,
not with every frame.

## Licence

[MIT](LICENSE)
