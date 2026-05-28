import { useMemo, useRef, useState } from "react";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";

const DEFAULT_ELEVENLABS_VOICE_ID = "uju3wxzG5OhpWcoi3SMy";
const ELEVENLABS_MODEL_ID = "eleven_multilingual_v2";
const DEFAULT_TEXT =
  "Testing system responsiveness, data transmission latency, and audio compilation fidelity between localized providers.";

const MAX_CHAR_THRESHOLD = 500;
const MALICIOUS_TAGS = ["<script>", "</script>", "<html>", "<iframe>"];
const ELEVENLABS_COST_PER_CHAR = 0.0003;
const POLLY_COST_PER_CHAR = 0.000016;
const ELEVENLABS_BITRATE = "128 kbps";
const POLLY_BITRATE = "64 kbps";

function sanitizeInput(text) {
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: false, error: "Payload field cannot be blank." };
  }
  if (trimmed.length > MAX_CHAR_THRESHOLD) {
    return {
      ok: false,
      error: `Payload bounds exceeded. Hard limit is ${MAX_CHAR_THRESHOLD} characters.`
    };
  }
  const lowered = trimmed.toLowerCase();
  for (const tag of MALICIOUS_TAGS) {
    if (lowered.includes(tag)) {
      return {
        ok: false,
        error: "Prohibited string pattern or injection attempt intercepted."
      };
    }
  }
  return { ok: true, value: trimmed };
}

function bytesToKb(byteLength) {
  return Math.round((byteLength / 1024) * 100) / 100;
}

function roundTo(value, decimals = 3) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function concatUint8Arrays(chunks, totalLength) {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function readStreamWithTtfb(stream) {
  if (!stream || !stream.getReader) {
    return { bytes: null, ttfbSeconds: null };
  }

  const reader = stream.getReader();
  const chunks = [];
  let totalLength = 0;
  const startTime = performance.now();
  let ttfbSeconds = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (ttfbSeconds === null) {
      ttfbSeconds = roundTo((performance.now() - startTime) / 1000, 3);
    }
    if (value) {
      chunks.push(value);
      totalLength += value.length;
    }
  }

  return {
    bytes: concatUint8Arrays(chunks, totalLength),
    ttfbSeconds
  };
}

function createDownload(jsonData) {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], {
    type: "application/json"
  });
  return URL.createObjectURL(blob);
}

export default function App() {
  const [elevenKey, setElevenKey] = useState("");
  const [awsKeyId, setAwsKeyId] = useState("");
  const [awsSecret, setAwsSecret] = useState("");
  const [awsRegion, setAwsRegion] = useState("us-east-1");
  const [inputText, setInputText] = useState(DEFAULT_TEXT);
  const [elevenVoiceId, setElevenVoiceId] = useState(
    DEFAULT_ELEVENLABS_VOICE_ID
  );

  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [elevenResult, setElevenResult] = useState(null);
  const [pollyResult, setPollyResult] = useState(null);
  const [exportUrl, setExportUrl] = useState("");

  const elevenAudioUrl = useRef("");
  const pollyAudioUrl = useRef("");

  const canRun = useMemo(() => {
    return elevenKey && awsKeyId && awsSecret && awsRegion;
  }, [elevenKey, awsKeyId, awsSecret, awsRegion]);

  async function runElevenLabs(text) {
    const startTime = performance.now();
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${elevenVoiceId}/stream?optimize_streaming_latency=0&output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "xi-api-key": elevenKey
        },
        body: JSON.stringify({
          text,
          model_id: ELEVENLABS_MODEL_ID
        })
      }
    );

    if (!response.ok) {
      const payload = await response.text();
      throw new Error(
        `ElevenLabs request failed: ${response.status} ${payload}`
      );
    }

    const audioStream = response.body;
    if (!audioStream) {
      throw new Error("ElevenLabs response stream not available.");
    }
    const { bytes, ttfbSeconds } = await readStreamWithTtfb(audioStream);
    if (!bytes) {
      throw new Error("Failed to read ElevenLabs audio stream.");
    }
    const endTime = performance.now();
    return {
      bytes: bytes.buffer,
      latencySeconds: roundTo((endTime - startTime) / 1000, 3),
      ttfbSeconds,
      region: response.headers.get("x-region") || "Unknown"
    };
  }

  async function runPolly(text) {
    const client = new PollyClient({
      region: awsRegion,
      credentials: {
        accessKeyId: awsKeyId,
        secretAccessKey: awsSecret
      }
    });

    const startTime = performance.now();
    const command = new SynthesizeSpeechCommand({
      Engine: "neural",
      Text: text,
      OutputFormat: "mp3",
      VoiceId: "Joanna"
    });

    const response = await client.send(command);
    const endTime = performance.now();

    if (!response.AudioStream) {
      throw new Error("Polly response missing audio stream.");
    }

    let audioBytes = null;
    let ttfbSeconds = null;

    if (response.AudioStream && response.AudioStream.getReader) {
      const streamResult = await readStreamWithTtfb(response.AudioStream);
      audioBytes = streamResult.bytes;
      ttfbSeconds = streamResult.ttfbSeconds;
    } else if (response.AudioStream) {
      audioBytes = response.AudioStream instanceof Uint8Array
        ? response.AudioStream
        : new Uint8Array(await response.AudioStream.transformToByteArray());
    }

    if (!audioBytes) {
      throw new Error("Failed to read Polly audio stream.");
    }

    return {
      bytes: audioBytes.buffer,
      latencySeconds: roundTo((endTime - startTime) / 1000, 3),
      ttfbSeconds,
      requestId: response.$metadata?.requestId || "Unavailable",
      retryAttempts: response.$metadata?.attempts ?? 0
    };
  }

  function revokeAudioUrls() {
    if (elevenAudioUrl.current) {
      URL.revokeObjectURL(elevenAudioUrl.current);
      elevenAudioUrl.current = "";
    }
    if (pollyAudioUrl.current) {
      URL.revokeObjectURL(pollyAudioUrl.current);
      pollyAudioUrl.current = "";
    }
    if (exportUrl) {
      URL.revokeObjectURL(exportUrl);
      setExportUrl("");
    }
  }

  async function handleRun() {
    setError("");
    revokeAudioUrls();

    const validation = sanitizeInput(inputText);
    if (!validation.ok) {
      setError(validation.error);
      return;
    }

    if (!canRun) {
      setError("Authentication credentials missing in the sidebar fields.");
      return;
    }

    setRunning(true);

    try {
      const [eleven, polly] = await Promise.all([
        runElevenLabs(validation.value),
        runPolly(validation.value)
      ]);

      const elevenBlob = new Blob([eleven.bytes], { type: "audio/mpeg" });
      const pollyBlob = new Blob([polly.bytes], { type: "audio/mpeg" });

      elevenAudioUrl.current = URL.createObjectURL(elevenBlob);
      pollyAudioUrl.current = URL.createObjectURL(pollyBlob);

      const elevenSize = bytesToKb(eleven.bytes.byteLength);
      const pollySize = bytesToKb(polly.bytes.byteLength);
      const textLength = validation.value.length;
      const elevenVelocity = roundTo(textLength / eleven.latencySeconds, 2);
      const pollyVelocity = roundTo(textLength / polly.latencySeconds, 2);
      const elevenCost = roundTo(textLength * ELEVENLABS_COST_PER_CHAR, 6);
      const pollyCost = roundTo(textLength * POLLY_COST_PER_CHAR, 6);
      const efficiencyRatio = pollyCost > 0
        ? roundTo(elevenCost / pollyCost, 2)
        : null;

      setElevenResult({
        latencySeconds: eleven.latencySeconds,
        sizeKb: elevenSize,
        url: elevenAudioUrl.current,
        ttfbSeconds: eleven.ttfbSeconds,
        velocity: elevenVelocity,
        estimatedCost: elevenCost,
        region: eleven.region,
        bitrate: ELEVENLABS_BITRATE
      });
      setPollyResult({
        latencySeconds: polly.latencySeconds,
        sizeKb: pollySize,
        url: pollyAudioUrl.current,
        ttfbSeconds: polly.ttfbSeconds,
        velocity: pollyVelocity,
        estimatedCost: pollyCost,
        requestId: polly.requestId,
        retryAttempts: polly.retryAttempts,
        bitrate: POLLY_BITRATE
      });

      const manifest = {
        meta: {
          text_length_chars: textLength,
          timestamp_epoch: Date.now() / 1000
        },
        benchmarks: {
          eleven_labs: {
            total_latency_sec: eleven.latencySeconds,
            file_size_kb: elevenSize,
            time_to_first_byte_sec: eleven.ttfbSeconds,
            characters_per_second: elevenVelocity,
            estimated_cost_usd: elevenCost,
            provider_region: eleven.region,
            audio_bitrate: ELEVENLABS_BITRATE
          },
          amazon_polly: {
            total_latency_sec: polly.latencySeconds,
            file_size_kb: pollySize,
            time_to_first_byte_sec: polly.ttfbSeconds,
            characters_per_second: pollyVelocity,
            estimated_cost_usd: pollyCost,
            aws_request_id: polly.requestId,
            aws_retry_attempts: polly.retryAttempts,
            audio_bitrate: POLLY_BITRATE
          }
        },
        efficiency_ratio: efficiencyRatio
      };

      setExportUrl(createDownload(manifest));
    } catch (err) {
      setError(err.message || "Unexpected error during benchmark run.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__header">
          <p className="eyebrow">BYOK Security</p>
          <h1>Cloud TTS Benchmark</h1>
        </div>
        <p className="sidebar__copy">
          Credentials stay in memory for this session and are never written to disk.
        </p>

        <div className="input-group">
          <label htmlFor="eleven-key">ElevenLabs API Key</label>
          <input
            id="eleven-key"
            type="password"
            value={elevenKey}
            onChange={(event) => setElevenKey(event.target.value)}
            placeholder="sk-..."
          />
        </div>

        <div className="input-group">
          <label htmlFor="eleven-voice">ElevenLabs Voice ID</label>
          <input
            id="eleven-voice"
            type="text"
            value={elevenVoiceId}
            onChange={(event) => setElevenVoiceId(event.target.value)}
            placeholder={DEFAULT_ELEVENLABS_VOICE_ID}
          />
          <p className="hint">
            Example free voice ID: EXAVITQu4vr4xnSDxMaL
          </p>
        </div>

        <div className="input-group">
          <label htmlFor="aws-key">AWS Access Key ID</label>
          <input
            id="aws-key"
            type="password"
            value={awsKeyId}
            onChange={(event) => setAwsKeyId(event.target.value)}
            placeholder="AKIA..."
          />
        </div>

        <div className="input-group">
          <label htmlFor="aws-secret">AWS Secret Access Key</label>
          <input
            id="aws-secret"
            type="password"
            value={awsSecret}
            onChange={(event) => setAwsSecret(event.target.value)}
            placeholder="********"
          />
        </div>

        <div className="input-group">
          <label htmlFor="aws-region">AWS Target Region</label>
          <input
            id="aws-region"
            type="text"
            value={awsRegion}
            onChange={(event) => setAwsRegion(event.target.value)}
            placeholder="us-east-1"
          />
        </div>

        <div className="helper-card">
          <p className="helper-card__title">Input guardrails</p>
          <p>
            500 character limit. Common injection tags are blocked before requests.
          </p>
        </div>
      </aside>

      <main className="main">
        <section className="hero">
          <div>
            <p className="eyebrow">Latency and audio quality</p>
            <h2>Benchmark generative and cloud-native speech in one pass.</h2>
            <p className="hero__copy">
              Compare response time, file size, and audio fidelity side-by-side.
            </p>
          </div>
          <div className="hero__panel">
            <label htmlFor="payload">Benchmark input sentence</label>
            <textarea
              id="payload"
              rows={6}
              value={inputText}
              onChange={(event) => setInputText(event.target.value)}
            />
            <button
              className="primary"
              type="button"
              onClick={handleRun}
              disabled={running || !canRun}
            >
              {running ? "Running benchmark..." : "Initialize benchmark run"}
            </button>
            {!canRun && (
              <p className="hint">
                Provide ElevenLabs and AWS credentials in the sidebar to run.
              </p>
            )}
            {error && <p className="error">{error}</p>}
          </div>
        </section>

        <section className="grid">
          <article className="card">
            <h3>ElevenLabs (Generative AI)</h3>
            <div className="metric">
              <span>Round-trip latency</span>
              <strong>
                {elevenResult ? `${elevenResult.latencySeconds} seconds` : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Time-to-first-byte</span>
              <strong>
                {elevenResult?.ttfbSeconds != null
                  ? `${elevenResult.ttfbSeconds} seconds`
                  : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Payload size</span>
              <strong>
                {elevenResult ? `${elevenResult.sizeKb} KB` : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Processing velocity</span>
              <strong>
                {elevenResult ? `${elevenResult.velocity} chars/sec` : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Estimated cost</span>
              <strong>
                {elevenResult ? `$${elevenResult.estimatedCost}` : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Audio compression</span>
              <strong>{elevenResult ? elevenResult.bitrate : "--"}</strong>
            </div>
            <audio controls src={elevenResult?.url || ""} />
          </article>

          <article className="card">
            <h3>Amazon Polly (Neural Standard)</h3>
            <div className="metric">
              <span>Round-trip latency</span>
              <strong>
                {pollyResult ? `${pollyResult.latencySeconds} seconds` : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Time-to-first-byte</span>
              <strong>
                {pollyResult?.ttfbSeconds != null
                  ? `${pollyResult.ttfbSeconds} seconds`
                  : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Payload size</span>
              <strong>{pollyResult ? `${pollyResult.sizeKb} KB` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Processing velocity</span>
              <strong>
                {pollyResult ? `${pollyResult.velocity} chars/sec` : "--"}
              </strong>
            </div>
            <div className="metric">
              <span>Estimated cost</span>
              <strong>{pollyResult ? `$${pollyResult.estimatedCost}` : "--"}</strong>
            </div>
            <div className="metric">
              <span>Audio compression</span>
              <strong>{pollyResult ? pollyResult.bitrate : "--"}</strong>
            </div>
            <audio controls src={pollyResult?.url || ""} />
          </article>
        </section>

        <section className="grid">
          <article className="card">
            <h3>Infrastructure insights</h3>
            <div className="meta-row">
              <span>ElevenLabs region</span>
              <strong>{elevenResult?.region || "--"}</strong>
            </div>
            <div className="meta-row">
              <span>AWS request ID</span>
              <strong>{pollyResult?.requestId || "--"}</strong>
            </div>
            <div className="meta-row">
              <span>AWS retry attempts</span>
              <strong>
                {pollyResult?.retryAttempts != null
                  ? pollyResult.retryAttempts
                  : "--"}
              </strong>
            </div>
            <div className="meta-row">
              <span>Efficiency ratio</span>
              <strong>
                {elevenResult && pollyResult && pollyResult.estimatedCost > 0
                  ? `${roundTo(
                      elevenResult.estimatedCost / pollyResult.estimatedCost,
                      2
                    )}x cheaper (Polly)`
                  : "--"}
              </strong>
            </div>
          </article>
        </section>

        <section className="export">
          <div>
            <h3>Compiled export data structure</h3>
            <p>
              Download a JSON snapshot of the run for downstream benchmarking.
            </p>
          </div>
          <div>
            <button type="button" className="secondary" disabled={!exportUrl}>
              {exportUrl ? (
                <a href={exportUrl} download="tts_benchmark_manifest.json">
                  Export benchmark metrics (JSON)
                </a>
              ) : (
                "Run a benchmark to export"
              )}
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}
