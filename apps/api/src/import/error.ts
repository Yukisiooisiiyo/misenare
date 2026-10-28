// 「資料を読めなかった」ことを利用者に伝える例外。
// これ以外の例外（Buffer の読み過ぎ、zlib の失敗など）は内部の事情なので、文面を利用者に見せない。
export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}
