/**
 * 応答待機中のキー入力を判定します。
 * 端末のカーソル位置・機能確認応答もESCで始まるため、ESCを含むだけでは中断しません。
 * 単独ESCは短時間保留し、分割された制御シーケンスの後続データが届いた場合は破棄します。
 */
export class TerminalCancellation {
  private pendingEscape?: ReturnType<typeof setTimeout>;
  constructor(private readonly cancel: () => void, private readonly toggle?: () => void) {}

  feed(data: Buffer | string): void {
    const sequence = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    const continuation = Boolean(this.pendingEscape);
    this.dispose();
    if (continuation) return;
    if (sequence === '\x14') this.toggle?.();
    else if (sequence === '\x1b[27u' || sequence === '\x1b[27;1u') this.cancel();
    else if (sequence === '\x1b') this.pendingEscape = setTimeout(() => {
      this.pendingEscape = undefined;
      this.cancel();
    }, 100);
  }

  /** 待機終了後に遅延中断が発火しないよう、保留中のタイマーを解除します。 */
  dispose(): void {
    if (this.pendingEscape) clearTimeout(this.pendingEscape);
    this.pendingEscape = undefined;
  }
}
