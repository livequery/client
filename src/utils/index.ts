import { v4 as uuidv4 } from 'uuid';

export function generateSubscriptionId() {
  return `client_${uuidv4()}`;
}
