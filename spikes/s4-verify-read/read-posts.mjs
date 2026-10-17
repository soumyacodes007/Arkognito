import {createHash} from 'node:crypto';
import {Group} from '@semaphore-protocol/group';
import {verifyProof} from '@semaphore-protocol/proof';
import {eq} from '@arkiv-network/sdk/query';

export const CONTENT_KEYS=['version','chainId','group','scope','rootBlock','owner','text'];
export function canonicalContent(content){
 if(!content||Object.keys(content).sort().join()!==[...CONTENT_KEYS].sort().join())throw Error('Unexpected content fields');
 if(content.version!==1||content.chainId!==7738577||typeof content.text!=='string'||Buffer.byteLength(content.text)>32768)throw Error('Invalid content schema');
 if(!/^0x[0-9a-fA-F]{40}$/.test(content.owner)||!/^\d+$/.test(content.rootBlock)||!/^\d+$/.test(content.scope)||typeof content.group!=='string')throw Error('Invalid content identifiers');
 return JSON.stringify(Object.fromEntries(CONTENT_KEYS.map(k=>[k,k==='owner'?content[k].toLowerCase():content[k]])));
}
export const contentMessage=content=>BigInt('0x'+createHash('sha256').update(canonicalContent(content)).digest('hex')).toString();
export const windowScope=(group,window)=>BigInt('0x'+createHash('sha256').update(JSON.stringify(['veil-semaphore-v1',7738577,group,window])).digest('hex')).toString();

export async function validatePost(post,group,scope,store){
 const {content,proof}=post;
 if(!content||!proof||content.group!==group||content.scope!==scope||proof.scope!==scope)throw Error('Group/scope mismatch');
 if(content.owner.toLowerCase()!==post.owner.toLowerCase())throw Error('Owner binding mismatch');
 if(proof.message!==contentMessage(content))throw Error('Content hash mismatch');
 const block=BigInt(content.rootBlock);
 if(block<0n||block>BigInt(post.createdAt)||block>await store.getHead())throw Error('Invalid rootBlock');
 if(post.attributes.nullifier!==proof.nullifier||post.attributes.root!==proof.merkleTreeRoot||String(post.attributes.rootblock)!==content.rootBlock||post.attributes.scope!==scope)throw Error('Proof attributes mismatch');
 const rules=await store.getGroupAt(group,block);
 if(!rules||!rules.readonly||rules.chainId!==7738577||proof.merkleTreeDepth!==rules.depth)throw Error('Invalid group rules');
 const members=await store.getMembersAt(group,block);
 members.sort((a,b)=>a.index-b.index);
 if(members.length<3||members.some((m,i)=>!Number.isSafeInteger(m.index)||m.index!==i)||new Set(members.map(m=>m.commitment)).size!==members.length)throw Error('Invalid ordered members');
 const rebuilt=new Group(members.map(m=>BigInt(m.commitment)));
 if(rebuilt.root.toString()!==proof.merkleTreeRoot)throw Error('Historical membership root mismatch');
 if(!await verifyProof(proof))throw Error('Invalid Semaphore proof');
 return true;
}

// Earliest VALID post wins. Within one block, key order is a declared deterministic tie-break,
// not a claim to recover transaction ordering from Arkiv's createdAt metadata.
export async function readPosts(group,scope,store){
 const head=await store.getHead();const posts=await store.listPosts(group,scope,head);
 posts.sort((a,b)=>BigInt(a.createdAt)<BigInt(b.createdAt)?-1:BigInt(a.createdAt)>BigInt(b.createdAt)?1:a.key.localeCompare(b.key));
 const accepted=[],rejected=[],seen=new Set();
 for(const post of posts){try{await validatePost(post,group,scope,store);const id=`${group}|${scope}|${post.proof.nullifier}`;if(seen.has(id))throw Error('Duplicate nullifier');seen.add(id);accepted.push(post);}catch(e){rejected.push({key:post.key,reason:e.message});}}
 return {accepted,rejected,snapshot:head.toString()};
}

export function arkivStore(reader,{project,admin,groupKey,trustedRelayers}){
 if(!trustedRelayers?.length)throw Error('Trusted relayers required');
 async function all(type,block,creator,filters=[]){const out=[];for await(const entity of reader.select({key:true,payload:true,attributes:true,creator:true,owner:true,createdAt:true,creationFlags:true}).where(eq('project',project),eq('type',type),...filters).createdBy(creator).atBlock(block).limit(200))out.push(entity);return out;}
 return {
  getHead:()=>reader.getBlockNumber({cacheTime:0}),
  async getGroupAt(group,block){if(group!==project)throw Error('Unknown group');const rows=await all('group',block,admin);const row=rows.find(e=>e.key===groupKey);if(!row)throw Error('Historical group not found');const rules=JSON.parse(new TextDecoder().decode(row.payload));return {chainId:rules.chainId,depth:rules.depth,readonly:row.creationFlags.readonly};},
  async getMembersAt(group,block){if(group!==project)throw Error('Unknown group');const rows=await all('member',block,admin);if(rows.some(e=>!e.creationFlags.readonly))throw Error('Mutable membership entity');return rows.map(e=>({index:Number(e.attributes.memberindex.value),commitment:String(e.attributes.commitment.value)}));},
  async listPosts(group,scope,head){if(group!==project)throw Error('Unknown group');const out=[];for(const creator of trustedRelayers){const rows=await all('post',head,creator,[eq('scope',scope)]);for(const e of rows){let data;try{data=JSON.parse(new TextDecoder().decode(e.payload));}catch{data={};}out.push({...data,key:e.key,owner:e.owner,createdAt:e.createdAt.toString(),attributes:Object.fromEntries(Object.entries(e.attributes).map(([k,v])=>[k,String(v.value)]))});}}return out;}
 };
}
