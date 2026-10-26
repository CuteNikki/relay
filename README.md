# relay

Stream to YouTube and Twitch at once while uploading only once. OBS sends a
single stream to your server, and the relay sends it on to both: to YouTube
untouched, at whatever quality you stream in, and to Twitch scaled down to
what Twitch takes.

It's useful when your upload can carry one high-quality stream but not two,
or when you want YouTube to get more than Twitch allows (say 1440p at
16 Mb/s on YouTube, 1080p at 6 Mb/s on Twitch).

## How it works

```
OBS ──RTMP──▶ MediaMTX ──▶ relay (FFmpeg) ──┬──▶ YouTube   copied as it comes in
              port 1936                     └──▶ Twitch    scaled and re-encoded
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

- A server with Docker and Docker Compose, with port **1936** reachable from
  where you stream.
- Enough CPU there for one x264 encode at Twitch's resolution (the `superfast`
  preset), which is all the relay encodes. Leave Twitch out and it encodes
  nothing at all.

## Setting it up

```bash
git clone https://github.com/CuteNikki/relay.git
cd relay
cp .env.example .env
```

Fill in `.env`:

- **`INBOUND_STREAM_KEY`**: a password you make up, which OBS streams with.
  Stick to letters, digits and `_`.
- **`YOUTUBE_STREAM_KEY`** and/or **`TWITCH_STREAM_KEY`**: set either or
  both. A platform without a key is left out.

Then start it:

```bash
docker compose up -d --build
```

## Setting up OBS

In **Settings → Stream**:

| Setting    | Value                                                 |
| ---------- | ----------------------------------------------------- |
| Service    | Custom…                                               |
| Server     | `rtmp://your-server:1936`                             |
| Stream key | `live?user=relay&pass=` and your `INBOUND_STREAM_KEY` |

For example, with `INBOUND_STREAM_KEY=hunter2` the stream key is
`live?user=relay&pass=hunter2`.

In **Settings → Output**, stream at the quality you want YouTube to get, since
YouTube receives exactly what OBS sends. Set the keyframe interval to 2
seconds, as YouTube asks.

## Settings

All in `.env`:

| Setting              | Default                           | What it's for                                                                                           |
| -------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `INBOUND_STREAM_KEY` | (required)                        | The password OBS streams with                                                                           |
| `YOUTUBE_STREAM_KEY` | (none)                            | Sends to YouTube when set                                                                               |
| `TWITCH_STREAM_KEY`  | (none)                            | Sends to Twitch when set                                                                                |
| `TWITCH_RESOLUTION`  | `1920x1080`                       | What Twitch's copy is scaled to                                                                         |
| `TWITCH_BITRATE`     | `6000k`                           | Twitch's video bitrate                                                                                  |
| `TWITCH_INGEST`      | `rtmp://live.twitch.tv/app`       | A Twitch server nearer you, from [Twitch's list](https://help.twitch.tv/s/twitch-ingest-recommendation) |
| `YOUTUBE_INGEST`     | `rtmp://a.rtmp.youtube.com/live2` | Another YouTube ingest address                                                                          |
| `STATUS_FILE`        | `/tmp/relay/status.json`          | Where it writes whether it's live (see below)                                                           |

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
      "lastError": "Error opening output files: I/O error"
    }
  ],
  "updatedAt": 1792700002000
}
```

Each output's `state` is `waiting` (no stream), `connecting`, `live` or
`retrying` (it failed and will try again). `retries` counts its restarts
during this stream, and `lastError` is what FFmpeg last complained of. The
`fps`, `bitrate`, `speed` and `droppedFrames` at the top cover the outputs
that are live: bitrates and dropped frames added up, frame rate and speed
from the slowest. A `speed` below `1x` means it's falling behind. A dashboard can read the file
with `docker exec rtmp-relay cat /tmp/relay/status.json`. The compose file
labels the container `dash.app: relay` for
[dash](https://github.com/CuteNikki/dash), which shows this on its tile.

To follow along as it streams:

```bash
docker compose logs -f rtmp-relay
```

## Licence

[MIT](LICENSE)
