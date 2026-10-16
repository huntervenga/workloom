import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ProtectedCommandRegistry } from './protectedCommands';
import { queryKeys } from './queryKeys';
const registries=new WeakMap<QueryClient,ProtectedCommandRegistry>();
/** Unsent drafts use their own registry so departure copy never claims a write was sent. */
export function protectedDraftsFor(client:QueryClient):ProtectedCommandRegistry {
 const known=registries.get(client);if(known)return known;const registry=new ProtectedCommandRegistry();registries.set(client,registry);
 let actor=(client.getQueryData(queryKeys.me) as {actor?:{id?:string}}|undefined)?.actor?.id;
 client.getQueryCache().subscribe(event=>{if(event.type!=='updated'||event.query.queryKey[0]!=='me')return;const next=(event.query.state.data as {actor?:{id?:string}}|undefined)?.actor?.id;if(next&&actor&&next!==actor)registry.clear();if(next)actor=next;});return registry;
}
export function useProtectedDraft(dirty:boolean):void {
 const registry=protectedDraftsFor(useQueryClient());
 useEffect(()=>{const entry=registry.register();entry.set(dirty);return entry.dispose;},[registry,dirty]);
}
