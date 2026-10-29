// 非保管ウォレットの共通契約です。秘密鍵を受け取るメソッドは提供しません。
export class WalletError extends Error { constructor(code){super(code);this.code=code;} }
export function address(value){if(typeof value!=='string'||!/^0x[0-9a-fA-F]{40}$/.test(value)||/^0x0{40}$/i.test(value))throw new WalletError('address');return value;}
const hex=value=>{if(typeof value!=='string'||!/^0x[0-9a-fA-F]+$/.test(value))throw new WalletError('rpc');return BigInt(value);};
const qty=value=>'0x'+value.toString(16);
const pad=value=>value.replace(/^0x/,'').toLowerCase().padStart(64,'0');
export function parseAmount(value,decimals){
  if(!Number.isInteger(decimals)||decimals<0||decimals>255||typeof value!=='string'||!/^\d+(\.\d+)?$/.test(value)||value.length>400)throw new WalletError('amount');
  const [whole,fraction='']=value.split('.');if(fraction.length>decimals)throw new WalletError('amount');
  const amount=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0')||'0');
  if(amount<=0n||amount>=2n**256n)throw new WalletError('amount');return amount;
}
export function formatAmount(amount,decimals){const digits=amount.toString().padStart(decimals+1,'0');if(!decimals)return digits;const fraction=digits.slice(-decimals).replace(/0+$/,'');return digits.slice(0,-decimals)+(fraction?'.'+fraction:'');}
export class WalletRegistry {
  constructor(){this.adapters=new Map();}
  register(id,adapter){if(this.adapters.has(id)||!['connect','balance','prepare','send','observe','disconnect'].every(key=>typeof adapter[key]==='function'))throw new WalletError('adapter');this.adapters.set(id,adapter);}
  get(id){const adapter=this.adapters.get(id);if(!adapter)throw new WalletError('adapter');return adapter;}
}
export class EthereumWalletAdapter {
  constructor(provider){
    if(!provider||typeof provider.request!=='function')throw new WalletError('provider');
    this.provider=provider;this.generation=0;this.prepared=new WeakMap();this.submitted=new Map();this.account=undefined;this.chain=undefined;
    this.invalidate=()=>{this.generation++;this.account=undefined;this.chain=undefined;};
    for(const event of ['accountsChanged','chainChanged','disconnect'])provider.on?.(event,this.invalidate);
  }
  async rpc(method,params=[]){try{return await this.provider.request({method,params});}catch(e){throw new WalletError(e?.code===4001?'rejected':'rpc');}}
  async connect(chainId){
    const requested=String(chainId);if(!/^[1-9]\d*$/.test(requested))throw new WalletError('chain');
    const accounts=await this.rpc('eth_requestAccounts');const chain=hex(await this.rpc('eth_chainId'));
    if(chain!==BigInt(requested))throw new WalletError('chain');
    this.account=address(accounts?.[0]);this.chain=chain;this.generation++;return {account:this.account,chainId:chain.toString()};
  }
  async assertSession(){
    if(!this.account||!this.chain)throw new WalletError('session');
    const chain=hex(await this.rpc('eth_chainId')),accounts=await this.rpc('eth_accounts');
    if(chain!==this.chain||accounts?.[0]?.toLowerCase()!==this.account.toLowerCase()){this.invalidate();throw new WalletError('session');}
  }
  async asset(token){
    if(!token)return {kind:'native',decimals:18};
    address(token);const code=await this.rpc('eth_getCode',[token,'latest']);if(code==='0x'||code==='0x0')throw new WalletError('token');
    const decimals=hex(await this.rpc('eth_call',[{to:token,data:'0x313ce567'},'latest']));
    if(decimals>255n)throw new WalletError('token');return {kind:'erc20',token,decimals:Number(decimals)};
  }
  async balance(token){await this.assertSession();const asset=await this.asset(token);const value=asset.kind==='native'?await this.rpc('eth_getBalance',[this.account,'latest']):await this.rpc('eth_call',[{to:token,data:'0x70a08231'+pad(this.account)},'latest']);return {...asset,raw:hex(value),amount:formatAmount(hex(value),asset.decimals)};}
  async prepare({recipient,amount,token}){
    await this.assertSession();address(recipient);const generation=this.generation,account=this.account,chain=this.chain;
    const asset=await this.asset(token),units=parseAmount(amount,asset.decimals);
    const transaction=asset.kind==='native'?{from:account,to:recipient,value:qty(units),chainId:qty(chain)}:{from:account,to:token,value:'0x0',data:'0xa9059cbb'+pad(recipient)+pad(qty(units)),chainId:qty(chain)};
    const gas=hex(await this.rpc('eth_estimateGas',[transaction]));const gasPrice=hex(await this.rpc('eth_gasPrice'));
    await this.assertSession();if(generation!==this.generation)throw new WalletError('session');
    const preview=Object.freeze({account,chainId:chain.toString(),recipient,amount,token:token||null,decimals:asset.decimals,feeEstimateWei:(gas*gasPrice).toString(),gas:qty(gas),transaction:Object.freeze({...transaction,gas:qty(gas)})});
    this.prepared.set(preview,this.generation);return preview;
  }
  async send(preview){
    if(!this.prepared.has(preview)||this.prepared.get(preview)!==this.generation)throw new WalletError('preview');
    this.prepared.delete(preview);await this.assertSession();
    if(preview.account.toLowerCase()!==this.account.toLowerCase()||preview.chainId!==this.chain.toString())throw new WalletError('session');
    // 見積りは上限ではありません。最終手数料と署名の承認は外部ウォレットで行います。
    const hash=await this.rpc('eth_sendTransaction',[preview.transaction]);
    if(!/^0x[0-9a-fA-F]{64}$/.test(hash))throw new WalletError('rpc');
    this.submitted.set(hash,{chainId:preview.chainId,preview});return {hash,status:'submitted'};
  }
  async observe(hash,minimumConfirmations=12){
    if(!Number.isSafeInteger(minimumConfirmations)||minimumConfirmations<1||minimumConfirmations>10000)throw new WalletError('confirmations');
    const submitted=this.submitted.get(hash);if(!submitted)throw new WalletError('transaction');
    if(hex(await this.rpc('eth_chainId')).toString()!==submitted.chainId)throw new WalletError('chain');
    const receipt=await this.rpc('eth_getTransactionReceipt',[hash]);if(!receipt)return {hash,status:'pending',confirmations:0};
    if(receipt.transactionHash?.toLowerCase()!==hash.toLowerCase())throw new WalletError('rpc');
    const block=await this.rpc('eth_getBlockByNumber',[receipt.blockNumber,false]);
    if(!block||block.hash!==receipt.blockHash)return {hash,status:'pending',confirmations:0};
    if(hex(receipt.status)!==1n)return {hash,status:'reverted',confirmations:0};
    // ERC-20の戻り値falseを成功扱いせず、対象資産の送金イベントを照合します。
    const expected=submitted.preview;
    if(expected.token){const transferTopic='0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
      const matches=(receipt.logs||[]).some(log=>log.address?.toLowerCase()===expected.token.toLowerCase()&&log.topics?.[0]===transferTopic&&log.topics[1]?.toLowerCase()==='0x'+pad(expected.account)&&log.topics[2]?.toLowerCase()==='0x'+pad(expected.recipient)&&hex(log.data)===parseAmount(expected.amount,expected.decimals));
      if(!matches)throw new WalletError('transfer');
    }
    const head=hex(await this.rpc('eth_blockNumber')),mined=hex(receipt.blockNumber);
    const confirmations=head>=mined?Number(head-mined+1n):0;
    return {hash,status:confirmations>=minimumConfirmations?'confirmed':'mined',confirmations};
  }
  disconnect(){for(const event of ['accountsChanged','chainChanged','disconnect'])this.provider.removeListener?.(event,this.invalidate);this.invalidate();this.submitted.clear();}
}
