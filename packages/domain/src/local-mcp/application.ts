import type {IssueLocalCredentialInput,RevokeLocalCredentialInput,LocalCredentialDto,LocalCredentialListDto,LocalMcpToolsDto,LocalMcpToolCall,LocalMcpToolResultDto} from '@workloom/contracts';
import type {CommandContext} from '../access/context.js';
export interface LocalCredentialApplication {
 issueCredential(context:CommandContext,input:IssueLocalCredentialInput):Promise<LocalCredentialDto>;
 listCredentials(context:CommandContext):Promise<LocalCredentialListDto>;
 revokeCredential(context:CommandContext,credentialId:string,input:RevokeLocalCredentialInput):Promise<LocalCredentialDto>;
}
/** Bearer is transport authentication only; never persist/log it or put it in tool arguments. */
export interface LocalMcpApplication {
 listTools(bearer:string,requestId:string):Promise<LocalMcpToolsDto>;
 callTool(bearer:string,requestId:string,call:LocalMcpToolCall):Promise<LocalMcpToolResultDto>;
}
