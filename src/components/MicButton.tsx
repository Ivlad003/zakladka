import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { cx } from '../lib/utils';
import { getSettings } from '../settings';

/** The browser's speech recognition, where there is one (Chrome, Edge, Safari). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

const RecognitionClass = ((window as unknown as Record<string, unknown>).SpeechRecognition ?? (window as unknown as Record<string, unknown>).webkitSpeechRecognition) as
  | (new () => Recognition)
  | undefined;

export const voiceTypingSupported = Boolean(RecognitionClass);

function voiceLanguage(): string {
  const s = getSettings();
  if (s.voiceLang.trim()) return s.voiceLang.trim();
  return s.aiLanguage === 'uk' ? 'uk-UA' : s.aiLanguage === 'en' ? 'en-US' : navigator.language || 'uk-UA';
}

const ERRORS: Record<string, string> = {
  'not-allowed': 'Немає доступу до мікрофона — дозвольте його для цього сайту.',
  'service-not-allowed': 'Розпізнавання мовлення в цьому браузері вимкнено. На телефоні можна диктувати кнопкою мікрофона на клавіатурі.',
  'audio-capture': 'Мікрофон не знайдено.',
  network: 'Розпізнавання мовлення потребує інтернету.',
  'language-not-supported': 'Ця мова не підтримується розпізнаванням у цьому браузері.',
};

interface Props {
  /** A finished phrase to add to the text. */
  onText(text: string): void;
  /** Words still being recognised, to show while speaking; empty when there are none. */
  onInterim?(text: string): void;
  onError?(message: string): void;
  disabled?: boolean;
}

/**
 * Voice typing: press, speak, press again. Shown only where the browser can recognise speech;
 * elsewhere the microphone key of the phone's own keyboard does the same job in any text field.
 */
export function MicButton({ onText, onInterim, onError, disabled }: Props) {
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<Recognition | null>(null);
  const handlers = useRef({ onText, onInterim, onError });
  handlers.current = { onText, onInterim, onError };

  useEffect(() => () => recognitionRef.current?.abort(), []);

  if (!RecognitionClass) return null;

  const toggle = () => {
    if (recognitionRef.current) return recognitionRef.current.stop();
    const recognition = new RecognitionClass();
    recognition.lang = voiceLanguage();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const phrase = e.results[i][0].transcript;
        if (e.results[i].isFinal) handlers.current.onText(phrase.trim());
        else interim += phrase;
      }
      handlers.current.onInterim?.(interim.trim());
    };
    recognition.onerror = (e) => {
      // "no-speech" and "aborted" are just silence and the stop button.
      if (e.error !== 'no-speech' && e.error !== 'aborted') handlers.current.onError?.(ERRORS[e.error] ?? `Не вдалося розпізнати мовлення (${e.error}).`);
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setListening(false);
      handlers.current.onInterim?.('');
    };
    try {
      recognition.start();
      recognitionRef.current = recognition;
      setListening(true);
    } catch {
      handlers.current.onError?.('Не вдалося ввімкнути мікрофон.');
    }
  };

  return (
    <button
      type="button"
      className={cx('icon-btn mic-btn', listening && 'listening')}
      onClick={toggle}
      disabled={disabled}
      title={listening ? 'Зупинити диктування' : 'Диктувати голосом'}
      aria-label={listening ? 'Зупинити диктування' : 'Диктувати голосом'}
      aria-pressed={listening}
    >
      <Mic size={17} />
    </button>
  );
}

/** Joins dictated text to what is already in a field, with a space where one is needed. */
export const appendSpoken = (current: string, spoken: string): string => (spoken ? `${current}${current && !/\s$/.test(current) ? ' ' : ''}${spoken}` : current);
