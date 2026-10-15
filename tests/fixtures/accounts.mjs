// Synthetic principals for non-password tests, persisted in the real account store.
export function seedAccounts(service,...users){
  for(const user of users)service.accounts.insert(user,{salt:Buffer.alloc(16),hash:Buffer.alloc(32),iterations:1});
  service.store.users.push(...users);service.refreshAccounts();
}
