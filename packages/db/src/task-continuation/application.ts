import { createHash } from 'node:crypto';
import { createTaskContinuationService, type TaskContinuationApplication } from '@workloom/domain';
import type { Database, WorkloomExecutor } from '../client.js';
import { createDependencyApplication } from '../dependencies/dependency-application.js';
import { createTaskDefaultsApplication } from '../task-defaults/application.js';
import { createTaskApplication } from '../tasks/task-application.js';

export function createTaskContinuationApplication(source: Database | WorkloomExecutor): TaskContinuationApplication {
  return createTaskContinuationService({
    tasks: createTaskApplication(source), dependencies: createDependencyApplication(source), defaults: createTaskDefaultsApplication(source),
    digest: value => createHash('sha256').update(value).digest('hex'),
  });
}
