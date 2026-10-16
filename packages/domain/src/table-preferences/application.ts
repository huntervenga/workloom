import type { PersonalTablePreferenceDto, UpdatePersonalTablePreferenceInput } from '@workloom/contracts';
import type { CommandContext } from '../access/context.js';
export interface PersonalTablePreferenceApplication {
  getPreference(context: CommandContext, projectId: string): Promise<PersonalTablePreferenceDto>;
  setPreference(context: CommandContext, projectId: string, input: UpdatePersonalTablePreferenceInput): Promise<PersonalTablePreferenceDto>;
}
