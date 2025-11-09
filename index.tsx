import { render } from "preact";
import { useState, useRef, useCallback, useEffect } from "preact/hooks";
import { html } from "htm/preact";
// FIX: 'LiveSession' is not an exported member of '@google/genai'.
// It has been removed and 'LiveServerMessage' has been added for use in callbacks.
import { GoogleGenAI, Modality, LiveServerMessage } from "@google/genai";

const SYSTEM_INSTRUCTION = `Agent Name: “ZPHS Conversation Buddy”
Voice: Friendly, young teacher voice with a clear American accent, warm and encouraging tone.
Purpose: To help Zilla Parishad High School (PM SHRI Program, Telangana) students practise real English conversations by talking about different school subjects and daily-life topics.

🧠 Agent Role

You are a voice-based conversation tutor, not a grammar teacher.
Your goal is to encourage students to speak in English naturally, build confidence, and make learning fun.
You listen carefully, respond naturally, and gently rephrase mistakes without explaining grammar.
Always use simple, child-friendly English.

🗣️ Conversation Flow

Greeting:
“Hello! I’m your English Conversation Buddy from ZPHS. I’m so happy to talk with you today!
What would you like to talk about? You can choose: Science, Social Studies, Sports, Health, or Daily Life.”

If a student chooses a topic (for example, ‘Science’), you will say:
“Wonderful choice! Let’s talk about Science. Do you like experiments or inventions?”
Then, listen to their answer, respond naturally and ask a follow-up question.

Keep the conversation light, supportive, and curious.
If a student is silent or shy, gently encourage them by saying: “Take your time. You can tell me one simple sentence. I’m listening.”
Celebrate every response with phrases like: “Excellent! You spoke very clearly!” or “Nice sentence! Let’s keep talking.”

After five minutes, wrap up the conversation by saying: “Let’s stop here for today. I loved our talk. You did great today! Keep talking in English — it makes you stronger! Proudly learning English at ZPHS — where every voice matters! That was a fun conversation! Remember — speak English every day, and your confidence will grow. See you next time! Goodbye!”
`;

const SESSION_DURATION = 5 * 60; // 5 minutes in seconds

interface TranscriptEntry {
    speaker: 'user' | 'buddy';
    text: string;
}

function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [statusMessage, setStatusMessage] = useState("Click the mic to start");
  const [isBuddySpeaking, setIsBuddySpeaking] = useState(false);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [currentUserText, setCurrentUserText] = useState('');
  const [currentBuddyText, setCurrentBuddyText] = useState('');
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);


  // FIX: Use 'any' for the session promise, as 'LiveSession' type is not exported from the library.
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const audioSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const sessionTimeoutRef = useRef<number | null>(null);
  const countdownIntervalRef = useRef<number | null>(null);
  
  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  useEffect(() => {
    if (transcriptContainerRef.current) {
        transcriptContainerRef.current.scrollTop = transcriptContainerRef.current.scrollHeight;
    }
  }, [transcript, currentUserText, currentBuddyText]);


  const cleanUpAudio = useCallback(() => {
    scriptProcessorRef.current?.disconnect();
    mediaStreamSourceRef.current?.disconnect();
    inputAudioContextRef.current?.close();
    outputAudioContextRef.current?.close();
    
    scriptProcessorRef.current = null;
    mediaStreamSourceRef.current = null;
    inputAudioContextRef.current = null;
    outputAudioContextRef.current = null;

    audioSourcesRef.current.forEach(source => source.stop());
    audioSourcesRef.current.clear();
    nextStartTimeRef.current = 0;
  }, []);

  const resetTranscription = () => {
      setTranscript([]);
      setCurrentUserText('');
      setCurrentBuddyText('');
      currentInputTranscription.current = '';
      currentOutputTranscription.current = '';
  }

  const stopSession = useCallback(async () => {
    setStatusMessage("Stopping session...");
     if (sessionTimeoutRef.current) {
        clearTimeout(sessionTimeoutRef.current);
        sessionTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
    }
    setTimeRemaining(null);

    if (sessionPromiseRef.current) {
        const session = await sessionPromiseRef.current;
        session.close();
        sessionPromiseRef.current = null;
    }
    cleanUpAudio();
    resetTranscription();
    setIsSessionActive(false);
    setIsBuddySpeaking(false);
    setStatusMessage("Click the mic to start");
  }, [cleanUpAudio]);


  // Audio helper functions
  const decode = (base64: string) => {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  };

  const encode = (bytes: Uint8Array) => {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  };

  const decodeAudioData = async (
    data: Uint8Array,
    ctx: AudioContext,
    sampleRate: number,
    numChannels: number,
  ): Promise<AudioBuffer> => {
    const dataInt16 = new Int16Array(data.buffer);
    const frameCount = dataInt16.length / numChannels;
    const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

    for (let channel = 0; channel < numChannels; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let i = 0; i < frameCount; i++) {
            channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
        }
    }
    return buffer;
  };

  const createBlob = (data: Float32Array) => {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) {
        int16[i] = data[i] * 32768;
    }
    return {
        data: encode(new Uint8Array(int16.buffer)),
        mimeType: 'audio/pcm;rate=16000',
    };
  };

  const startSession = async () => {
    setStatusMessage("Connecting...");
    setIsSessionActive(true);
    resetTranscription();
    
    // Start timers
    sessionTimeoutRef.current = window.setTimeout(stopSession, SESSION_DURATION * 1000);
    setTimeRemaining(SESSION_DURATION);
    countdownIntervalRef.current = window.setInterval(() => {
        setTimeRemaining(prev => (prev ? prev - 1 : 0));
    }, 1000);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      sessionPromiseRef.current = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        callbacks: {
            onopen: () => {
              setStatusMessage("Listening...");
              mediaStreamSourceRef.current = inputAudioContextRef.current.createMediaStreamSource(stream);
              scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
              
              scriptProcessorRef.current.onaudioprocess = (audioProcessingEvent) => {
                const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                if (sessionPromiseRef.current) {
                    sessionPromiseRef.current.then((session) => {
                        session.sendRealtimeInput({ media: pcmBlob });
                    });
                }
              };
              
              mediaStreamSourceRef.current.connect(scriptProcessorRef.current);
              scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);
            },
            // FIX: Added 'LiveServerMessage' type to the 'onmessage' callback parameter for improved type safety.
            onmessage: async (message: LiveServerMessage) => {
              const base64EncodedAudioString = message.serverContent?.modelTurn?.parts[0]?.inlineData.data;
              if (base64EncodedAudioString) {
                setIsBuddySpeaking(true);
                setStatusMessage("Buddy is speaking...");
                
                const outputAudioContext = outputAudioContextRef.current;
                if (!outputAudioContext) return;

                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outputAudioContext.currentTime);
                const audioBuffer = await decodeAudioData(decode(base64EncodedAudioString), outputAudioContext, 24000, 1);
                
                const source = outputAudioContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outputAudioContext.destination);
                
                source.addEventListener('ended', () => {
                    audioSourcesRef.current.delete(source);
                    if (audioSourcesRef.current.size === 0) {
                        setIsBuddySpeaking(false);
                        if (isSessionActive) {
                            setStatusMessage("Listening...");
                        }
                    }
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                audioSourcesRef.current.add(source);
              }
              
              if (message.serverContent?.inputTranscription) {
                const text = message.serverContent.inputTranscription.text;
                currentInputTranscription.current += text;
                setCurrentUserText(currentInputTranscription.current);
              }

              if (message.serverContent?.outputTranscription) {
                const text = message.serverContent.outputTranscription.text;
                currentOutputTranscription.current += text;
                setCurrentBuddyText(currentOutputTranscription.current);
              }
              
              if (message.serverContent?.turnComplete) {
                const fullInput = currentInputTranscription.current;
                const fullOutput = currentOutputTranscription.current;
                
                setTranscript(prev => {
                    const newTranscript = [...prev];
                    if (fullInput.trim()) newTranscript.push({ speaker: 'user', text: fullInput.trim() });
                    if (fullOutput.trim()) newTranscript.push({ speaker: 'buddy', text: fullOutput.trim() });
                    return newTranscript;
                });

                currentInputTranscription.current = '';
                currentOutputTranscription.current = '';
                setCurrentUserText('');
                setCurrentBuddyText('');
              }


              const interrupted = message.serverContent?.interrupted;
              if (interrupted) {
                  audioSourcesRef.current.forEach(source => source.stop());
                  audioSourcesRef.current.clear();
                  nextStartTimeRef.current = 0;
                  setIsBuddySpeaking(false);
                  if (isSessionActive) {
                    setStatusMessage("Listening...");
                  }
              }
            },
            onerror: (e) => {
              console.error('Session error', e);
              setStatusMessage("Error occurred. Please try again.");
              stopSession();
            },
            onclose: () => {
              console.log('Session closed');
              // Check if session was closed intentionally
              if (isSessionActive) {
                stopSession();
              }
            },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Zephyr' } },
          },
          systemInstruction: SYSTEM_INSTRUCTION,
        },
      });
    } catch (error) {
        console.error("Failed to start session:", error);
        setStatusMessage("Could not access microphone.");
        setIsSessionActive(false);
    }
  };

  const handleToggleConversation = () => {
    if (isSessionActive) {
      // Set isSessionActive to false here to prevent onclose from re-triggering stopSession
      setIsSessionActive(false);
      stopSession();
    } else {
      startSession();
    }
  };
  
  const formatTime = (seconds: number | null) => {
    if (seconds === null) return '';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const micButtonClass = `mic-button ${isSessionActive ? 'active' : ''} ${isSessionActive && !isBuddySpeaking ? 'listening' : ''}`;

  return html`
    <div class="app-container">
      <header>
        <h1>ZPHS Conversation Buddy</h1>
        <p>PM SHRI English Initiative</p>
      </header>
      <div class="transcript-container" ref=${transcriptContainerRef}>
        ${transcript.length === 0 && !currentUserText && !currentBuddyText ? html`
            <div class="transcript-placeholder">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="M256 32C114.6 32 0 125.1 0 240c0 49.6 21.4 95 57 130.7C44.5 421.1 2.7 466 2.2 466.5c-2.2 2.3-2.8 5.7-1.5 8.7S4.8 480 8 480c66.3 0 116-31.8 146.3-59.4c21.7 5.2 44.4 8.1 67.7 8.1c141.4 0 256-93.1 256-208S397.4 32 256 32z"/></svg>
                <span>Your conversation will appear here. Press the microphone to begin!</span>
            </div>
        ` : html`
            ${transcript.map(entry => html`
                <div class="transcript-entry ${entry.speaker}">
                    <div class="speaker-label">${entry.speaker === 'user' ? 'You' : 'Buddy'}</div>
                    <div class="message-bubble">${entry.text}</div>
                </div>
            `)}
            ${currentUserText && html`
                <div class="transcript-entry user">
                    <div class="speaker-label">You</div>
                    <div class="message-bubble">${currentUserText}</div>
                </div>
            `}
            ${currentBuddyText && html`
                <div class="transcript-entry buddy">
                    <div class="speaker-label">Buddy</div>
                    <div class="message-bubble">${currentBuddyText}</div>
                </div>
            `}
        `}
      </div>
      <div class="timer">${formatTime(timeRemaining)}</div>
      <button class=${micButtonClass} onClick=${handleToggleConversation} aria-label=${isSessionActive ? 'Stop conversation' : 'Start conversation'}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512">
            <path d="M192 0C139 0 96 43 96 96V256c0 53 43 96 96 96s96-43 96-96V96c0-53-43-96-96-96zM64 216c0-13.3-10.7-24-24-24s-24 10.7-24 24v40c0 89.1 66.2 162.7 152 174.4V464H120c-13.3 0-24 10.7-24 24s10.7 24 24 24h144c13.3 0 24-10.7 24-24s-10.7-24-24-24h-48v-25.6c85.8-11.7 152-85.3 152-174.4V216c0-13.3-10.7-24-24-24s-24 10.7-24 24v40c0 70.7-57.3 128-128 128s-128-57.3-128-128V216z"/>
          </svg>
      </button>
      <div class="status-text">${statusMessage}</div>
      <footer>Proudly learning English at ZPHS!</footer>
    </div>
  `;
}

render(html`<${App} />`, document.getElementById("root"));