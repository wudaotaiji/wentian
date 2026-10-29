/** ウォレット拡張の契約。秘密鍵を受け取らず、署名は各アダプターの接続先で行います。 */
export interface WalletSession {account:string;chainId:string}
export interface TransferRequest {recipient:string;amount:string;token?:string}
export interface TransferObservation {hash:string;status:'submitted'|'pending'|'mined'|'confirmed'|'reverted';confirmations?:number}
export interface WalletAdapter<Preview=unknown,Balance=unknown> {
  connect(network:string):Promise<WalletSession>;
  balance(asset?:string):Promise<Balance>;
  prepare(request:TransferRequest):Promise<Preview>;
  send(preview:Preview):Promise<TransferObservation>;
  observe(hash:string,minimumConfirmations?:number):Promise<TransferObservation>;
  disconnect():void;
}
