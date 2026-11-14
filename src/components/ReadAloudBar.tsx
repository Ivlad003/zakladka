import { useEffect, useState } from 'react';
import { Pause, Play, Volume2, X } from 'lucide-react';
import { aloudSupported, isIos, pauseAloud, prepareAloud, resumeAloud, setAloudOptions, startAloud, stopAloud, useAloud, voicesFor, type AloudOptions, type AloudSource } from '../lib/read-aloud';
import { updateSettings, useSettings } from '../settings';

const RATES = [0.8, 1, 1.2, 1.5, 1.8];
const LANGS: [string, string][] = [
  ['', 'Мова: авто'],
  ['uk', 'Українська'],
  ['en', 'English'],
  ['pl', 'Polski'],
  ['de', 'Deutsch'],
  ['fr', 'Français'],
  ['es', 'Español'],
  ['ru', 'Русский'],
];

interface Props {
  source: AloudSource;
  onClose(): void;
}

/** The little player shown while the book is read aloud: pause, speed, voice. */
export function ReadAloudBar({ source, onClose }: Props) {
  const settings = useSettings();
  const aloud = useAloud();
  // Voices arrive a moment after the page has loaded in some browsers.
  const [, setVoicesTick] = useState(0);
  useEffect(() => {
    if (!aloudSupported()) return;
    const onVoices = () => setVoicesTick((n) => n + 1);
    speechSynthesis.addEventListener?.('voiceschanged', onVoices);
    return () => speechSynthesis.removeEventListener?.('voiceschanged', onVoices);
  }, []);
  // Leaving the book stops the voice.
  useEffect(() => () => stopAloud(), []);
  // The page on screen is read ahead, so that a tap on ▶ can start speaking at once (iOS needs that).
  useEffect(() => {
    if (!aloudSupported()) return;
    const ahead = () => void prepareAloud(source, { lang: settings.aloudLang }).catch(() => {});
    ahead();
    const timer = setInterval(ahead, 1500);
    return () => clearInterval(timer);
  }, [source, settings.aloudLang]);

  const options: AloudOptions = { rate: settings.aloudRate, voices: settings.aloudVoices, lang: settings.aloudLang };
  const change = (patch: Partial<Pick<AloudOptions, 'rate' | 'voices' | 'lang'>>) => {
    const next = { ...options, ...patch };
    updateSettings({ aloudRate: next.rate, aloudVoices: next.voices, aloudLang: next.lang });
    setAloudOptions(next);
  };

  if (!aloudSupported()) {
    return (
      <div className="aloud-bar" role="status">
        <span className="aloud-text">Цей браузер не вміє читати вголос.</span>
        <button className="icon-btn" onClick={onClose} title="Закрити" aria-label="Закрити">
          <X size={16} />
        </button>
      </div>
    );
  }

  const lang = aloud.lang || settings.aloudLang;
  const voices = lang ? voicesFor(lang) : [];
  const playing = aloud.status === 'playing';
  const toggle = () => (aloud.status === 'idle' ? startAloud(source, options) : playing ? pauseAloud() : resumeAloud());

  return (
    <div className="aloud-bar" role="group" aria-label="Читання вголос">
      <div className="aloud-row">
        <button className="icon-btn aloud-play" onClick={toggle} title={playing ? 'Пауза' : 'Читати вголос із цієї сторінки'} aria-label={playing ? 'Пауза' : 'Читати'}>
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="aloud-text" aria-live="off">
          {aloud.sentence || aloud.note || (aloud.status === 'idle' ? 'Натисніть ▶, щоб читати з цієї сторінки' : '…')}
        </span>
        <button
          className="btn small aloud-rate"
          onClick={() => change({ rate: RATES[(RATES.indexOf(settings.aloudRate) + 1) % RATES.length] })}
          title="Швидкість читання"
          aria-label={`Швидкість ${settings.aloudRate}`}
        >
          {String(settings.aloudRate).replace('.', ',')}×
        </button>
        <button
          className="icon-btn"
          onClick={() => {
            stopAloud();
            onClose();
          }}
          title="Зупинити й закрити"
          aria-label="Зупинити й закрити"
        >
          <X size={16} />
        </button>
      </div>
      <div className="aloud-row aloud-voice">
        <Volume2 size={14} />
        <select value={settings.aloudLang} onChange={(e) => change({ lang: e.target.value })} aria-label="Мова читання">
          {LANGS.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        {lang && (
          <select value={settings.aloudVoices[lang] ?? ''} onChange={(e) => change({ voices: { ...settings.aloudVoices, [lang]: e.target.value } })} aria-label="Голос" disabled={!voices.length}>
            <option value="">{voices.length ? 'Голос: типовий' : 'Немає голосу для цієї мови'}</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name}
                {v.localService ? '' : ' (онлайн)'}
              </option>
            ))}
          </select>
        )}
      </div>
      {aloud.note && aloud.sentence && <small className="aloud-note">{aloud.note}</small>}
      {aloud.status === 'idle' && !aloud.note && isIos() && <small className="aloud-note">На iPhone голос не чути в беззвучному режимі — перемикач збоку.</small>}
    </div>
  );
}
