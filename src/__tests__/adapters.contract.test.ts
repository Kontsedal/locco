import { runLockAdapterContract } from '../testing/contract';
import { ALL_BACKENDS } from './backends';

for (const [name, make] of ALL_BACKENDS) {
  runLockAdapterContract(name, make);
}
