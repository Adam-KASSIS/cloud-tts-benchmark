import json
import os
import time

import boto3
import requests
import streamlit as st
from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs

load_dotenv()

DEFAULT_TEXT = (
    "Testing system responsiveness, data transmission latency, and audio compilation "
    "fidelity between localized providers."
)
MAX_CHAR_THRESHOLD = 500
MALICIOUS_TAGS = ["<script>", "</script>", "<html>", "<iframe>"]
ELEVENLABS_COST_PER_CHAR = 0.0003
POLLY_COST_PER_CHAR = 0.000016
ELEVENLABS_BITRATE = "128 kbps"
POLLY_BITRATE = "64 kbps"
DEFAULT_ELEVENLABS_VOICE_ID = "uju3wxzG5OhpWcoi3SMy"
ELEVENLABS_MODEL_ID = "eleven_multilingual_v2"

st.set_page_config(
    page_title="Cloud TTS Performance Benchmarking",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.sidebar.title("\ud83d\udd11 API Authentication")
st.sidebar.markdown(
    "Inputs are stored purely within active session memory and are never persisted."
)

default_el_key = os.getenv("ELEVENLABS_API_KEY", "")
default_aws_id = os.getenv("AWS_ACCESS_KEY_ID", "")
default_aws_secret = os.getenv("AWS_SECRET_ACCESS_KEY", "")
default_aws_region = os.getenv("AWS_REGION", "us-east-1")

eleven_key = st.sidebar.text_input(
    "ElevenLabs API Key",
    value=default_el_key,
    type="password",
    help="Grab this from your ElevenLabs Profile dashboard.",
)
eleven_voice_id = st.sidebar.text_input(
    "ElevenLabs Voice ID",
    value=DEFAULT_ELEVENLABS_VOICE_ID,
)
st.sidebar.caption("Example free voice ID: EXAVITQu4vr4xnSDxMaL")

aws_key_id = st.sidebar.text_input(
    "AWS Access Key ID",
    value=default_aws_id,
    type="password",
)
aws_secret = st.sidebar.text_input(
    "AWS Secret Access Key",
    value=default_aws_secret,
    type="password",
)
aws_region = st.sidebar.text_input("AWS Target Region", value=default_aws_region)


def enforce_security_boundary(text: str) -> tuple[bool, str]:
    text = text.strip()
    if not text:
        return False, "Payload field cannot be blank."
    if len(text) > MAX_CHAR_THRESHOLD:
        return False, f"Payload bounds exceeded. Hard limit is {MAX_CHAR_THRESHOLD} characters."
    lowered = text.lower()
    for tag in MALICIOUS_TAGS:
        if tag in lowered:
            return False, "Prohibited string pattern or injection attempt intercepted."
    return True, text


def initialize_providers():
    if not eleven_key or not aws_key_id or not aws_secret:
        return None, None, "Authentication credentials missing in sidebar."

    try:
        el_client = ElevenLabs(api_key=eleven_key)
        polly_client = boto3.client(
            "polly",
            aws_access_key_id=aws_key_id,
            aws_secret_access_key=aws_secret,
            region_name=aws_region,
        )
        return el_client, polly_client, None
    except Exception as exc:
        return None, None, f"Failed client handshake: {str(exc)}"


def stream_ttfb_and_bytes(iterable):
    start = time.time()
    ttfb = None
    chunks = []
    total = 0

    for chunk in iterable:
        if ttfb is None:
            ttfb = time.time() - start
        if chunk:
            chunks.append(chunk)
            total += len(chunk)

    return b"".join(chunks), ttfb


def execute_elevenlabs_benchmark(text: str):
    url = (
        f"https://api.elevenlabs.io/v1/text-to-speech/{eleven_voice_id}/stream"
        "?optimize_streaming_latency=0&output_format=mp3_44100_128"
    )
    headers = {"Content-Type": "application/json", "xi-api-key": eleven_key}
    payload = {"text": text, "model_id": ELEVENLABS_MODEL_ID}

    start = time.time()
    with requests.post(url, json=payload, headers=headers, stream=True) as resp:
        if not resp.ok:
            raise RuntimeError(f"ElevenLabs request failed: {resp.status_code} {resp.text}")
        audio_bytes, ttfb = stream_ttfb_and_bytes(resp.iter_content(chunk_size=4096))
        region = resp.headers.get("x-region", "Unknown")

    latency = time.time() - start
    return {
        "bytes": audio_bytes,
        "latency": round(latency, 3),
        "ttfb": round(ttfb, 3) if ttfb is not None else None,
        "region": region,
    }


def execute_polly_benchmark(client, text: str):
    start = time.time()
    response = client.synthesize_speech(
        Engine="neural",
        Text=text,
        OutputFormat="mp3",
        VoiceId="Joanna",
    )
    stream = response.get("AudioStream")
    if not stream:
        raise RuntimeError("Polly response missing audio stream.")

    def iter_stream():
        while True:
            data = stream.read(4096)
            if not data:
                break
            yield data

    audio_bytes, ttfb = stream_ttfb_and_bytes(iter_stream())
    latency = time.time() - start
    metadata = response.get("ResponseMetadata", {})

    return {
        "bytes": audio_bytes,
        "latency": round(latency, 3),
        "ttfb": round(ttfb, 3) if ttfb is not None else None,
        "request_id": metadata.get("RequestId", "Unavailable"),
        "retry_attempts": metadata.get("RetryAttempts", 0),
    }


st.title("\ud83c\udf99\ufe0f Cloud TTS Benchmarking Sandbox")
st.markdown(
    "Analyze raw throughput velocity, encoding densities, and acoustic qualities between generative and traditional TTS layers."
)

user_payload = st.text_area(
    "Benchmark Input Sentence:",
    value=DEFAULT_TEXT,
    height=120,
)

if st.button("Initialize Benchmark Run", type="primary"):
    el_client, polly_client, auth_error = initialize_providers()

    if auth_error:
        st.error(f"\ud83d\udd12 Access Blocked: {auth_error}")
    else:
        is_safe, evaluation_content = enforce_security_boundary(user_payload)
        if not is_safe:
            st.error(f"\ud83d\udee1\ufe0f Security Exception: {evaluation_content}")
        else:
            status = st.empty()
            status.info("\u26a1 Measuring network throughput and running provider handshakes...")

            try:
                eleven = execute_elevenlabs_benchmark(evaluation_content)
                polly = execute_polly_benchmark(polly_client, evaluation_content)

                status.empty()

                text_length = len(evaluation_content)
                eleven_size = round(len(eleven["bytes"]) / 1024, 2)
                polly_size = round(len(polly["bytes"]) / 1024, 2)

                eleven_velocity = round(text_length / eleven["latency"], 2)
                polly_velocity = round(text_length / polly["latency"], 2)
                eleven_cost = round(text_length * ELEVENLABS_COST_PER_CHAR, 6)
                polly_cost = round(text_length * POLLY_COST_PER_CHAR, 6)
                efficiency_ratio = round(eleven_cost / polly_cost, 2) if polly_cost else None

                col1, col2 = st.columns(2)

                with col1:
                    st.markdown("### \ud83d\udd2e ElevenLabs (Generative AI)")
                    st.metric("Round-Trip Latency", f"{eleven['latency']} seconds")
                    st.metric(
                        "Time-to-First-Byte",
                        "--" if eleven["ttfb"] is None else f"{eleven['ttfb']} seconds",
                    )
                    st.metric("Payload Size", f"{eleven_size} KB")
                    st.metric("Processing Velocity", f"{eleven_velocity} chars/sec")
                    st.metric("Estimated Cost", f"${eleven_cost}")
                    st.metric("Audio Compression", ELEVENLABS_BITRATE)
                    st.audio(eleven["bytes"], format="audio/mp3")

                with col2:
                    st.markdown("### \u2601\ufe0f Amazon Polly (Neural Standard)")
                    st.metric("Round-Trip Latency", f"{polly['latency']} seconds")
                    st.metric(
                        "Time-to-First-Byte",
                        "--" if polly["ttfb"] is None else f"{polly['ttfb']} seconds",
                    )
                    st.metric("Payload Size", f"{polly_size} KB")
                    st.metric("Processing Velocity", f"{polly_velocity} chars/sec")
                    st.metric("Estimated Cost", f"${polly_cost}")
                    st.metric("Audio Compression", POLLY_BITRATE)
                    st.audio(polly["bytes"], format="audio/mp3")

                st.markdown("---")
                st.subheader("Infrastructure Insights")
                st.write(f"ElevenLabs region: {eleven['region']}")
                st.write(f"AWS request ID: {polly['request_id']}")
                st.write(f"AWS retry attempts: {polly['retry_attempts']}")
                st.write(
                    f"Efficiency ratio: {efficiency_ratio}x cheaper (Polly)"
                    if efficiency_ratio is not None
                    else "Efficiency ratio: --"
                )

                st.markdown("---")
                st.subheader("\ud83d\udcca Compiled Export Data Structure")

                telemetry_manifest = {
                    "meta": {
                        "text_length_chars": text_length,
                        "timestamp_epoch": time.time(),
                    },
                    "benchmarks": {
                        "eleven_labs": {
                            "total_latency_sec": eleven["latency"],
                            "file_size_kb": eleven_size,
                            "time_to_first_byte_sec": eleven["ttfb"],
                            "characters_per_second": eleven_velocity,
                            "estimated_cost_usd": eleven_cost,
                            "provider_region": eleven["region"],
                            "audio_bitrate": ELEVENLABS_BITRATE,
                        },
                        "amazon_polly": {
                            "total_latency_sec": polly["latency"],
                            "file_size_kb": polly_size,
                            "time_to_first_byte_sec": polly["ttfb"],
                            "characters_per_second": polly_velocity,
                            "estimated_cost_usd": polly_cost,
                            "aws_request_id": polly["request_id"],
                            "aws_retry_attempts": polly["retry_attempts"],
                            "audio_bitrate": POLLY_BITRATE,
                        },
                    },
                    "efficiency_ratio": efficiency_ratio,
                }

                st.json(telemetry_manifest)

                st.download_button(
                    label="\ud83d\udce5 Export Benchmark Metrics (.JSON)",
                    data=json.dumps(telemetry_manifest, indent=4),
                    file_name="tts_benchmark_manifest.json",
                    mime="application/json",
                )
            except Exception as exc:
                status.empty()
                st.error(
                    "\u274c Core Exception occurred during runtime engine execution: "
                    f"{str(exc)}"
                )
