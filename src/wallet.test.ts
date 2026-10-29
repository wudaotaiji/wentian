import test from 'node:test';
import assert from 'node:assert/strict';
const moduleUrl=new URL('./wallet/client.mjs',import.meta.url);
const {EthereumWalletAdapter,WalletRegistry,parseAmount,formatAmount}=await import(moduleUrl.href);
const account='0x'+'1'.repeat(40),recipient='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64),blockHash='0x'+'b'.repeat(64);
function mock(){let chain='0x539',accounts=[account],status='0x1';let sends=0;const events=new Map<string,Function>();
 const provider={on:(name:string,fn:Function)=>events.set(name,fn),removeListener:(name:string)=>events.delete(name),request:async({method}:any)=>{switch(method){case 'eth_requestAccounts':case 'eth_accounts':return accounts;case 'eth_chainId':return chain;case 'eth_estimateGas':return '0x5208';case 'eth_gasPrice':return '0x1';case 'eth_sendTransaction':sends++;return hash;case 'eth_getTransactionReceipt':return {transactionHash:hash,status,blockNumber:'0x1',blockHash};case 'eth_getBlockByNumber':return {hash:blockHash};case 'eth_blockNumber':return '0x2';default:throw Error(method)}}};
 return {provider,events,sends:()=>sends,changeChain:()=>{chain='0x1';events.get('chainChanged')?.(chain)},revert:()=>status='0x0',changeAccount:()=>{accounts=[recipient];events.get('accountsChanged')?.(accounts)}};
}
test('金額を浮動小数へ変換せず精度・負数・指数表記・ゼロを検証する',()=>{
 assert.equal(parseAmount('9007199254740993.000000000000000001',18),9007199254740993000000000000000001n);
 for(const value of ['0','-1','1e6','1.0000001','NaN'])assert.throws(()=>parseAmount(value,6));
 assert.equal(formatAmount(1000000000000000000n,18),'1');
});
test('見積りを一回だけ送信でき、確認数・失敗を区別する',async()=>{
 const mocker=mock(),adapter=new EthereumWalletAdapter(mocker.provider);const registry=new WalletRegistry();registry.register('ethereum',adapter);assert.equal(registry.get('ethereum'),adapter);assert.throws(()=>registry.register('ethereum',adapter));
 await adapter.connect('1337');const preview=await adapter.prepare({recipient,amount:'1'});
 assert.equal(preview.transaction.chainId,'0x539');await adapter.send(preview);await assert.rejects(adapter.send(preview));assert.equal(mocker.sends(),1);
 assert.equal((await adapter.observe(hash,3)).status,'mined');assert.equal((await adapter.observe(hash,2)).status,'confirmed');mocker.revert();assert.equal((await adapter.observe(hash,2)).status,'reverted');
});
test('ネットワークまたは口座変更後の旧見積りを拒否する',async()=>{
 for(const change of ['changeChain','changeAccount'] as const){const mocker=mock(),adapter=new EthereumWalletAdapter(mocker.provider);await adapter.connect('1337');const preview=await adapter.prepare({recipient,amount:'1'});mocker[change]();await assert.rejects(adapter.send(preview));assert.equal(mocker.sends(),0);}
});
test('同じネットワーク・口座への再接続後も旧見積りを再利用できない',async()=>{
 const mocker=mock(),adapter=new EthereumWalletAdapter(mocker.provider);await adapter.connect('1337');const preview=await adapter.prepare({recipient,amount:'1'});await adapter.connect('1337');await assert.rejects(adapter.send(preview));assert.equal(mocker.sends(),0);
});
