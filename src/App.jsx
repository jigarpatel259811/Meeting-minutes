import React, { useState, useRef, useEffect, useCallback } from "react";
import { Mic, Square, Loader2, Copy, Check, Download, Eye, EyeOff, RotateCcw, FileText, ListChecks, Users, ScrollText } from "lucide-react";

const STAGE = {
  SETUP: "setup",
  IDLE: "idle",
  RECORDING: "recording",
  TRANSCRIBING: "transcribing",
  SUMMARIZING: "summarizing",
  DONE: "done",
  ERROR: "error",
};

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

export default function MeetingMinutes() {
  const [stage, setStage] = useState(STAGE.SETUP);
  const [apiKey, setApiKey] = useState("");
  const [claudeKey, setClaudeKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [showClaudeKey, setShowClaudeKey] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [minutes, setMinutes] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [statusLine, setStatusLine] = useState("");

  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const audioCtxRef = useRef(null);
  const analyserRef = useRef(null);
  const canvasRef = useRef(null);
  const rafRef = useRef(null);

  const cleanupAudio = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
  }, []);

  useEffect(() => () => cleanupAudio(), [cleanupAudio]);

  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const render = () => {
      analyser.getByteFrequencyData(dataArray);
      const w = canvas.width;
      const h = canvas.height;
      ctx.clearRect(0, 0, w, h);
      const barCount = 40;
      const step = Math.floor(bufferLength / barCount);
      const barWidth = w / barCount;
      for (let i = 0; i < barCount; i++) {
        const v = dataArray[i * step] / 255;
        const barHeight = Math.max(4, v * h);
        ctx.fillStyle = "#B4622E";
        const x = i * barWidth;
        const y = (h - barHeight) / 2;
        ctx.fillRect(x + barWidth * 0.2, y, barWidth * 0.6, barHeight);
      }
      rafRef.current = requestAnimationFrame(render);
    };
    render();
  }, []);

  const startRecording = async () => {
    setErrorMsg("");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      drawWaveform();

      const mimeType = MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : MediaRecorder.isTypeSupported("audio/mp4")
        ? "audio/mp4"
        : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType || "audio/webm" });
        handleTranscribe(blob);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();

      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setStage(STAGE.RECORDING);
    } catch (err) {
      setErrorMsg("Couldn't access the microphone. Check your browser's permission settings and try again.");
      setStage(STAGE.ERROR);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) clearInterval(timerRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioCtxRef.current && audioCtxRef.current.state !== "closed") audioCtxRef.current.close();
  };

  const handleTranscribe = async (blob) => {
    setStage(STAGE.TRANSCRIBING);
    setStatusLine("Uploading audio…");
    try {
      const uploadRes = await fetch("https://api.assemblyai.com/v2/upload", {
        method: "POST",
        headers: { authorization: apiKey },
        body: blob,
      });
      if (!uploadRes.ok) throw new Error("Upload to the transcription service failed.");
      const uploadData = await uploadRes.json();

      setStatusLine("Starting transcription…");
      const transcriptRes = await fetch("https://api.assemblyai.com/v2/transcript", {
        method: "POST",
        headers: { authorization: apiKey, "content-type": "application/json" },
        body: JSON.stringify({ audio_url: uploadData.upload_url }),
      });
      if (!transcriptRes.ok) throw new Error("Couldn't start the transcription job.");
      const transcriptJob = await transcriptRes.json();

      let result = transcriptJob;
      setStatusLine("Transcribing audio…");
      while (result.status !== "completed" && result.status !== "error") {
        await new Promise((r) => setTimeout(r, 3000));
        const pollRes = await fetch(`https://api.assemblyai.com/v2/transcript/${transcriptJob.id}`, {
          headers: { authorization: apiKey },
        });
        result = await pollRes.json();
      }

      if (result.status === "error") throw new Error(result.error || "Transcription failed.");
      if (!result.text || !result.text.trim()) throw new Error("No speech was detected in the recording.");

      setTranscript(result.text);
      await handleSummarize(result.text);
    } catch (err) {
      setErrorMsg(err.message || "Something went wrong during transcription.");
      setStage(STAGE.ERROR);
    }
  };

  const handleSummarize = async (transcriptText) => {
    setStage(STAGE.SUMMARIZING);
    setStatusLine("Writing the minutes…");
    try {
      const prompt = `Convert this in-person meeting transcript into structured meeting minutes. Output ONLY valid JSON, no markdown fences, no preamble, matching exactly this schema:

{
  "title": "concise meeting title inferred from the content",
  "summary": "2-3 sentence overview of the meeting",
  "attendees": ["names mentioned as participants, empty array if none identifiable"],
  "keyPoints": ["main discussion points, each a short sentence"],
  "decisions": ["decisions that were made, empty array if none"],
  "actionItems": [{"task": "what needs to be done", "owner": "person responsible, or Unassigned", "dueDate": "date if mentioned, or Not specified"}]
}

Transcript:
${transcriptText}`;

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": claudeKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1500,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const data = await response.json();
      const textBlock = data.content.find((b) => b.type === "text");
      const cleaned = (textBlock?.text || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      setMinutes(parsed);
      setStage(STAGE.DONE);
    } catch (err) {
      setErrorMsg("The recording was transcribed, but generating the minutes failed. Your transcript is still available below.");
      setStage(STAGE.ERROR);
    }
  };

  const reset = () => {
    setStage(STAGE.IDLE);
    setTranscript("");
    setMinutes(null);
    setErrorMsg("");
    setElapsed(0);
    setShowTranscript(false);
  };

  const minutesAsText = () => {
    if (!minutes) return "";
    const lines = [];
    lines.push(minutes.title || "Meeting Minutes");
    lines.push("");
    lines.push(minutes.summary || "");
    lines.push("");
    if (minutes.attendees?.length) {
      lines.push("ATTENDEES");
      minutes.attendees.forEach((a) => lines.push(`- ${a}`));
      lines.push("");
    }
    if (minutes.keyPoints?.length) {
      lines.push("KEY POINTS");
      minutes.keyPoints.forEach((k) => lines.push(`- ${k}`));
      lines.push("");
    }
    if (minutes.decisions?.length) {
      lines.push("DECISIONS");
      minutes.decisions.forEach((d) => lines.push(`- ${d}`));
      lines.push("");
    }
    if (minutes.actionItems?.length) {
      lines.push("ACTION ITEMS");
      minutes.actionItems.forEach((a) => lines.push(`- ${a.task} — ${a.owner} (${a.dueDate})`));
    }
    return lines.join("\n");
  };

  const copyMinutes = async () => {
    try {
      await navigator.clipboard.writeText(minutesAsText());
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  };

  const downloadMinutes = () => {
    const blob = new Blob([minutesAsText()], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(minutes?.title || "meeting-minutes").replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.txt`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ minHeight: "100vh", background: "#EDE7DC", fontFamily: "'Source Sans Pro', 'Segoe UI', sans-serif", color: "#2B2621" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500;600;700&family=Source+Sans+Pro:wght@400;600;700&display=swap');
        .mono { font-family: 'IBM Plex Mono', monospace; }
        * { box-sizing: border-box; }
        button:focus-visible, input:focus-visible { outline: 2px solid #B4622E; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
        @keyframes pulseRing { 0% { box-shadow: 0 0 0 0 rgba(180,98,46,0.35); } 100% { box-shadow: 0 0 0 22px rgba(180,98,46,0); } }
      `}</style>

      <div style={{ maxWidth: 640, margin: "0 auto", padding: "48px 20px 80px" }}>
        <header style={{ marginBottom: 36, borderBottom: "2px solid #2B2621", paddingBottom: 16 }}>
          <div className="mono" style={{ fontSize: 12, letterSpacing: 2, color: "#8A7A63", marginBottom: 6 }}>
            RECORD &nbsp;→&nbsp; TRANSCRIBE &nbsp;→&nbsp; MINUTE
          </div>
          <h1 className="mono" style={{ fontSize: 28, fontWeight: 700, margin: 0, letterSpacing: -0.5 }}>
            Meeting Minutes
          </h1>
        </header>

        {stage === STAGE.SETUP && (
          <div style={{ background: "#FAF7F1", border: "1px solid #D8CFBC", borderRadius: 4, padding: 24 }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: 600, marginBottom: 10, color: "#8A7A63", letterSpacing: 1 }}>
              STEP 1 — TRANSCRIPTION KEY
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, marginTop: 0, marginBottom: 16 }}>
              This tool uses AssemblyAI to turn your recording into text. Paste a free API key from{" "}
              <span className="mono" style={{ background: "#EDE7DC", padding: "1px 5px", borderRadius: 3 }}>assemblyai.com</span>{" "}
              — it stays in this browser tab only and is never saved.
            </p>
            <KeyInput value={apiKey} onChange={setApiKey} show={showKey} setShow={setShowKey} placeholder="AssemblyAI API key" />

            <div className="mono" style={{ fontSize: 13, fontWeight: 600, margin: "22px 0 10px", color: "#8A7A63", letterSpacing: 1 }}>
              STEP 2 — ANTHROPIC KEY
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, marginTop: 0, marginBottom: 16 }}>
              Used to turn the transcript into structured minutes. Get a key from{" "}
              <span className="mono" style={{ background: "#EDE7DC", padding: "1px 5px", borderRadius: 3 }}>console.anthropic.com</span>.
            </p>
            <KeyInput value={claudeKey} onChange={setClaudeKey} show={showClaudeKey} setShow={setShowClaudeKey} placeholder="Anthropic API key" />

            <button
              onClick={() => setStage(STAGE.IDLE)}
              disabled={!apiKey.trim() || !claudeKey.trim()}
              style={{
                marginTop: 18,
                width: "100%",
                padding: "12px 0",
                background: apiKey.trim() && claudeKey.trim() ? "#2B2621" : "#C7BBA3",
                color: "#FAF7F1",
                border: "none",
                borderRadius: 3,
                fontSize: 14,
                fontWeight: 600,
                cursor: apiKey.trim() && claudeKey.trim() ? "pointer" : "not-allowed",
              }}
              className="mono"
            >
              Continue
            </button>
          </div>
        )}

        {(stage === STAGE.IDLE || stage === STAGE.RECORDING) && (
          <div style={{ background: "#FAF7F1", border: "1px solid #D8CFBC", borderRadius: 4, padding: 32, textAlign: "center" }}>
            <canvas ref={canvasRef} width={320} height={64} style={{ width: "100%", maxWidth: 320, height: 64, display: stage === STAGE.RECORDING ? "block" : "none", margin: "0 auto 20px" }} />
            {stage === STAGE.IDLE && (
              <p style={{ fontSize: 14, color: "#8A7A63", marginTop: 0, marginBottom: 28 }}>
                Set the recorder on the table and press record when the meeting starts.
              </p>
            )}
            {stage === STAGE.RECORDING && (
              <div className="mono" style={{ fontSize: 32, fontWeight: 700, marginBottom: 20 }}>
                {formatTime(elapsed)}
              </div>
            )}
            <button
              onClick={stage === STAGE.IDLE ? startRecording : stopRecording}
              style={{
                width: 84,
                height: 84,
                borderRadius: "50%",
                border: "none",
                background: stage === STAGE.RECORDING ? "#B4622E" : "#2B2621",
                color: "#FAF7F1",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                animation: stage === STAGE.RECORDING ? "pulseRing 1.6s infinite" : "none",
              }}
              aria-label={stage === STAGE.IDLE ? "Start recording" : "Stop recording"}
            >
              {stage === STAGE.IDLE ? <Mic size={32} /> : <Square size={28} fill="#FAF7F1" />}
            </button>
            <div className="mono" style={{ fontSize: 12, letterSpacing: 1.5, color: "#8A7A63", marginTop: 16 }}>
              {stage === STAGE.IDLE ? "PRESS TO RECORD" : "RECORDING — PRESS TO STOP"}
            </div>
          </div>
        )}

        {(stage === STAGE.TRANSCRIBING || stage === STAGE.SUMMARIZING) && (
          <div style={{ background: "#FAF7F1", border: "1px solid #D8CFBC", borderRadius: 4, padding: 40, textAlign: "center" }}>
            <Loader2 size={28} className="mono" style={{ animation: "spin 1s linear infinite", color: "#B4622E" }} />
            <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            <div className="mono" style={{ fontSize: 13, letterSpacing: 1, color: "#8A7A63", marginTop: 14 }}>
              {statusLine.toUpperCase()}
            </div>
          </div>
        )}

        {stage === STAGE.ERROR && (
          <div style={{ background: "#FAF3EE", border: "1px solid #E0B49A", borderRadius: 4, padding: 24 }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: 600, color: "#B4622E", marginBottom: 8 }}>
              SOMETHING WENT WRONG
            </div>
            <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>{errorMsg}</p>
            {transcript && (
              <div style={{ marginTop: 16, padding: 14, background: "#fff", borderRadius: 3, fontSize: 13, lineHeight: 1.6, whiteSpace: "pre-wrap", maxHeight: 240, overflowY: "auto" }}>
                {transcript}
              </div>
            )}
            <button
              onClick={reset}
              className="mono"
              style={{ marginTop: 18, display: "inline-flex", alignItems: "center", gap: 8, padding: "10px 16px", background: "#2B2621", color: "#FAF7F1", border: "none", borderRadius: 3, cursor: "pointer", fontSize: 13 }}
            >
              <RotateCcw size={14} /> Try again
            </button>
          </div>
        )}

        {stage === STAGE.DONE && minutes && (
          <div>
            <div style={{ background: "#FAF7F1", border: "1px solid #D8CFBC", borderRadius: 4, padding: 28, marginBottom: 16 }}>
              <div className="mono" style={{ fontSize: 12, letterSpacing: 1.5, color: "#8A7A63", marginBottom: 6 }}>
                MEETING MINUTES
              </div>
              <h2 style={{ fontSize: 22, fontWeight: 700, margin: "0 0 14px" }}>{minutes.title}</h2>
              <p style={{ fontSize: 14, lineHeight: 1.65, color: "#4A4238", margin: 0 }}>{minutes.summary}</p>

              {minutes.attendees?.length > 0 && (
                <Section icon={<Users size={15} />} label="Attendees">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {minutes.attendees.map((a, i) => (
                      <span key={i} className="mono" style={{ fontSize: 12, background: "#EDE7DC", padding: "4px 10px", borderRadius: 12 }}>{a}</span>
                    ))}
                  </div>
                </Section>
              )}

              {minutes.keyPoints?.length > 0 && (
                <Section icon={<FileText size={15} />} label="Key points">
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.8 }}>
                    {minutes.keyPoints.map((k, i) => <li key={i}>{k}</li>)}
                  </ul>
                </Section>
              )}

              {minutes.decisions?.length > 0 && (
                <Section icon={<ScrollText size={15} />} label="Decisions">
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14, lineHeight: 1.8 }}>
                    {minutes.decisions.map((d, i) => <li key={i}>{d}</li>)}
                  </ul>
                </Section>
              )}

              {minutes.actionItems?.length > 0 && (
                <Section icon={<ListChecks size={15} />} label="Action items">
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {minutes.actionItems.map((a, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 13.5, padding: "8px 10px", background: "#EDE7DC", borderRadius: 3 }}>
                        <span>{a.task}</span>
                        <span className="mono" style={{ color: "#8A7A63", whiteSpace: "nowrap" }}>{a.owner} · {a.dueDate}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}
            </div>

            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <ActionButton onClick={copyMinutes} icon={copied ? <Check size={15} /> : <Copy size={15} />} label={copied ? "Copied" : "Copy"} />
              <ActionButton onClick={downloadMinutes} icon={<Download size={15} />} label="Download .txt" />
              <ActionButton onClick={reset} icon={<RotateCcw size={15} />} label="New recording" />
            </div>

            <button
              onClick={() => setShowTranscript((s) => !s)}
              className="mono"
              style={{ fontSize: 12, letterSpacing: 1, color: "#8A7A63", background: "none", border: "none", cursor: "pointer", padding: 0 }}
            >
              {showTranscript ? "HIDE FULL TRANSCRIPT ▲" : "SHOW FULL TRANSCRIPT ▼"}
            </button>
            {showTranscript && (
              <div style={{ marginTop: 10, padding: 16, background: "#fff", border: "1px solid #D8CFBC", borderRadius: 4, fontSize: 13, lineHeight: 1.7, whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>
                {transcript}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KeyInput({ value, onChange, show, setShow, placeholder }) {
  return (
    <div style={{ position: "relative" }}>
      <input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={{
          width: "100%",
          padding: "12px 44px 12px 14px",
          border: "1px solid #C7BBA3",
          borderRadius: 3,
          fontSize: 14,
          background: "#fff",
        }}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide key" : "Show key"}
        style={{ position: "absolute", right: 10, top: 10, background: "none", border: "none", cursor: "pointer", color: "#8A7A63" }}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

function Section({ icon, label, children }) {
  return (
    <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid #E4DDCB" }}>
      <div className="mono" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, letterSpacing: 1.2, color: "#8A7A63", marginBottom: 10, textTransform: "uppercase" }}>
        {icon} {label}
      </div>
      {children}
    </div>
  );
}

function ActionButton({ onClick, icon, label }) {
  return (
    <button
      onClick={onClick}
      className="mono"
      style={{
        flex: 1,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        padding: "10px 12px",
        background: "#2B2621",
        color: "#FAF7F1",
        border: "none",
        borderRadius: 3,
        fontSize: 12.5,
        cursor: "pointer",
      }}
    >
      {icon} {label}
    </button>
  );
}
