import { pidAlive } from '../machine/process-identity';
import { type Task } from '../../shared/contracts';
import type { Resolution } from '../resolution';

export type ValidationRetryContext = Pick<Resolution, 'store' | 'update'>;

export class ValidationRetry {
  constructor(readonly context: ValidationRetryContext) {}
  retryProjectValidationEffect(task: Task): Task {
    const current=this.context.store.task(task.id), validation=current.resolution.projectValidation;
    const lost=validation?.state==='running'&&!(validation.pid&&pidAlive(validation.pid));
    if(current.version!==task.version)throw new Error('Task changed before project-validation retry; refresh task detail');
    if(!['hold','refused'].includes(validation?.state ?? '')&&!lost)throw new Error('Project validation is still running or has no held result to retry');
    if(!current.resolution.attention)throw new Error('The task has no owner resolution retry for its project validation');
    return this.context.update(current,{attention:false,projectValidation:null},{reason:'Project validation retry requested'},'project_validation_retry_requested');
  }
}
