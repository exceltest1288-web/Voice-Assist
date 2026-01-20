
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { ConnectionStatus, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createPcmBlob } from './utils/audio-utils';
import TranscriptionsList from './components/TranscriptionsList';

const App: React.FC = () => {
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.IDLE);
  const [history, setHistory] = useState<TranscriptionEntry[]>([]);
  const [activeInput, setActiveInput] = useState<string>('');
  const [activeOutput, setActiveOutput] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const [isMicActive, setIsMicActive] = useState<boolean>(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const outputCtxRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const speedRef = useRef<number>(1.0);
  
  // Noise gate refs
  const silenceTimerRef = useRef<number | null>(null);
  const SILENCE_THRESHOLD = 0.01; // Minimum volume to consider as "speech"
  const SILENCE_DURATION = 1500; // ms to wait before "muting" the stream

  // Sync ref for the audio processing callback
  useEffect(() => {
    speedRef.current = playbackSpeed;
  }, [playbackSpeed]);

  const startSession = async () => {
    setErrorMsg(null);
    try {
      setStatus(ConnectionStatus.CONNECTING);
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      streamRef.current = stream;

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
      
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputCtxRef.current || outputCtxRef.current.state === 'closed') {
        outputCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      if (audioCtxRef.current.state === 'suspended') await audioCtxRef.current.resume();
      if (outputCtxRef.current.state === 'suspended') await outputCtxRef.current.resume();

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            const source = audioCtxRef.current!.createMediaStreamSource(streamRef.current!);
            const scriptProcessor = audioCtxRef.current!.createScriptProcessor(4096, 1, 1);
            
            scriptProcessor.onaudioprocess = (event) => {
              const inputData = event.inputBuffer.getChannelData(0);
              
              // Simple volume check for the noise gate
              let maxVal = 0;
              for (let i = 0; i < inputData.length; i++) {
                const abs = Math.abs(inputData[i]);
                if (abs > maxVal) maxVal = abs;
              }

              if (maxVal > SILENCE_THRESHOLD) {
                // Speech detected
                if (silenceTimerRef.current) {
                  clearTimeout(silenceTimerRef.current);
                  silenceTimerRef.current = null;
                }
                if (!isMicActive) setIsMicActive(true);

                const pcmBlob = createPcmBlob(inputData);
                sessionPromiseRef.current?.then((session) => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              } else {
                // Silence detected
                if (!silenceTimerRef.current) {
                  silenceTimerRef.current = window.setTimeout(() => {
                    setIsMicActive(false);
                  }, SILENCE_DURATION);
                }
              }
            };

            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxRef.current!.destination);
          },
          onmessage: async (message: LiveServerMessage) => {
            if (message.serverContent?.inputTranscription) {
              setActiveInput(prev => prev + message.serverContent!.inputTranscription!.text);
            }
            if (message.serverContent?.outputTranscription) {
              setActiveOutput(prev => prev + message.serverContent!.outputTranscription!.text);
            }

            const modelTurn = message.serverContent?.modelTurn;
            if (modelTurn) {
              for (const part of modelTurn.parts) {
                if (part.inlineData?.data) {
                  const base64Audio = part.inlineData.data;
                  const outCtx = outputCtxRef.current!;
                  nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
                  
                  const audioBuffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
                  const source = outCtx.createBufferSource();
                  source.buffer = audioBuffer;
                  source.playbackRate.value = speedRef.current;
                  source.connect(outCtx.destination);
                  
                  source.addEventListener('ended', () => {
                    sourcesRef.current.delete(source);
                  });

                  source.start(nextStartTimeRef.current);
                  nextStartTimeRef.current += (audioBuffer.duration / speedRef.current);
                  sourcesRef.add(source);
                }
                if (part.text) {
                  setActiveOutput(prev => prev + part.text);
                }
              }
            }

            if (message.serverContent?.turnComplete) {
              setHistory(prev => {
                const newEntries: TranscriptionEntry[] = [];
                if (activeInput || activeOutput) {
                  newEntries.push({ 
                    speaker: 'user', 
                    text: activeInput || "[Voice Input Received]", 
                    timestamp: Date.now() 
                  });
                  newEntries.push({ 
                    speaker: 'model', 
                    text: activeOutput || "[Translation Spoken]", 
                    timestamp: Date.now() + 1 
                  });
                }
                return [...prev, ...newEntries];
              });
              setActiveInput('');
              setActiveOutput('');
            }

            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => {
                try { s.stop(); } catch(e) {}
              });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setErrorMsg("Connection error or feature not supported in this region.");
            setStatus(ConnectionStatus.ERROR);
          },
          onclose: () => {
            setStatus(ConnectionStatus.IDLE);
            setIsMicActive(false);
          }
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          systemInstruction: `Translate English to Urdu and Urdu to English instantly. 
          Respond ONLY with the translation in audio format. 
          Do not explain or engage in side conversation.`
        }
      });

      sessionPromiseRef.current = sessionPromise;

    } catch (err: any) {
      console.error('Failed to start session:', err);
      setStatus(ConnectionStatus.ERROR);
      setErrorMsg(err.message || "Failed to start voice assistant.");
    }
  };

  const stopSession = () => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    sessionPromiseRef.current?.then(session => {
      try { session.close(); } catch(e) {}
    });
    sessionPromiseRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    setStatus(ConnectionStatus.IDLE);
    setIsMicActive(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 md:p-8">
      <div className="w-full max-w-2xl bg-white rounded-3xl shadow-2xl overflow-hidden flex flex-col border border-slate-200">
        
        <header className="bg-indigo-600 text-white p-6 text-center relative">
          <h1 className="text-2xl font-bold tracking-tight">LingoBridge</h1>
          <p className="text-indigo-100 opacity-90 text-sm mt-1">English ↔ Urdu Live Bridge</p>
          {status === ConnectionStatus.CONNECTED && (
            <div className="absolute top-6 right-6 flex items-center gap-2">
              <span className={`w-2 h-2 rounded-full ${isMicActive ? 'bg-green-400' : 'bg-slate-400'}`} />
              <span className="text-[10px] uppercase font-bold text-white/70">
                {isMicActive ? 'Mic Active' : 'Mic Auto-Muted'}
              </span>
            </div>
          )}
        </header>

        <main className="flex-1 p-6 space-y-6">
          {errorMsg && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 px-4 py-3 rounded-xl text-sm flex items-center gap-3">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="flex justify-between items-end px-2">
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-3 h-3 rounded-full ${status === ConnectionStatus.CONNECTED ? 'bg-green-500 animate-pulse' : 'bg-slate-300'}`} />
              <span className="text-xs font-semibold text-slate-500 uppercase tracking-widest">{status}</span>
            </div>
            
            <div className="flex flex-col items-end gap-2 bg-slate-50 p-3 rounded-xl border border-slate-100">
              <label htmlFor="speed" className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">Speed: {playbackSpeed}x</label>
              <input 
                id="speed"
                type="range" 
                min="0.5" 
                max="2.0" 
                step="0.1" 
                value={playbackSpeed}
                onChange={(e) => setPlaybackSpeed(parseFloat(e.target.value))}
                className="w-24 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
            </div>
          </div>

          <TranscriptionsList history={history} />

          {(activeInput || activeOutput) && (
            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              {activeInput && (
                <div className="mb-2">
                  <span className="text-[10px] font-bold text-blue-500 uppercase">Input...</span>
                  <p className="text-slate-600 italic text-sm">{activeInput}</p>
                </div>
              )}
              {activeOutput && (
                <div>
                  <span className="text-[10px] font-bold text-indigo-500 uppercase">Translating...</span>
                  <p className="text-slate-800 font-medium text-sm">{activeOutput}</p>
                </div>
              )}
            </div>
          )}
        </main>

        <footer className="p-6 bg-slate-50 border-t border-slate-200 flex flex-col items-center">
          {status !== ConnectionStatus.CONNECTED ? (
            <button
              onClick={startSession}
              disabled={status === ConnectionStatus.CONNECTING}
              className="group relative flex items-center justify-center w-20 h-20 bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-400 text-white rounded-full shadow-lg transition-all transform active:scale-95"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
              {status === ConnectionStatus.CONNECTING && (
                <div className="absolute inset-0 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" />
              )}
            </button>
          ) : (
            <button
              onClick={stopSession}
              className="group flex items-center justify-center w-20 h-20 bg-red-500 hover:bg-red-600 text-white rounded-full shadow-lg transition-all transform active:scale-95"
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
          <p className="mt-4 text-sm font-medium text-slate-500 text-center">
            {status === ConnectionStatus.CONNECTED ? 'Mic is live (Auto-gates silence)' : 'Start English-Urdu Bridge'}
          </p>
        </footer>
      </div>
    </div>
  );
};

export default App;
