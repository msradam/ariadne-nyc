export interface TTSAdapter {
  speak(text: string, lang?: string): void;
  cancel(): void;
  readonly supported: boolean;
}

export class LocalSpeechSynthesisAdapter implements TTSAdapter {
  private synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;

  get supported(): boolean {
    return !!this.synth;
  }

  speak(text: string, lang = 'en-US'): void {
    if (!this.synth) return;
    this.synth.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.lang = lang;
    // Prefer local voices to avoid sending text off-device.
    const voices = this.synth.getVoices();
    const local = voices.find(
      (v) => v.localService && v.lang.startsWith(lang.split('-')[0])
    );
    if (local) utt.voice = local;
    this.synth.speak(utt);
  }

  cancel(): void {
    this.synth?.cancel();
  }
}
