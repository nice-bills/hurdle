import { createPublicClient, http, parseAbi } from "viem";
const c = createPublicClient({ transport: http("https://sepolia.unichain.org") });
const v = "0xa8F0dbf46b7C87477E6fe8FB4aE9474F7AF3Ba7D";
const abi = parseAbi(["function nav() view returns (uint256)","function start() view returns (uint64,uint160,uint256,uint256,uint256)","function position() view returns (int24,int24,uint128)","function epochStart() view returns (uint64)","function poolId() view returns (bytes32)","function bondValue() view returns (uint256)","function totalSupply() view returns (uint256)","function curator() view returns (address)"]);
const head = await c.getBlockNumber();
for (const f of ["nav","start","position","epochStart","poolId","bondValue","totalSupply","curator"]) console.log(f, await c.readContract({address:v,abi,functionName:f}).catch(e=>e.shortMessage));
try { console.log("hist", await c.readContract({address:v,abi,functionName:"start",blockNumber: head-1200n})); } catch(e){ console.log("hist err", e.shortMessage); }
const hook = parseAbi(["function twapTick(bytes32) view returns (int24)","function consult(bytes32,uint32) view returns (int24)","function referenceTick(bytes32) view returns (int24)"]);
const pid = await c.readContract({address:v,abi,functionName:"poolId"});
console.log("twap", await c.readContract({address:"0x7EECdD6507E77db3247C9E9bccFA0AcFf5F410a0",abi:hook,functionName:"twapTick",args:[pid]}).catch(e=>e.shortMessage));
const code = await c.getCode({address:"0xcA11bde05977b3631167028862bE2a173976CA11"}); console.log("multicall3", code?.length);
