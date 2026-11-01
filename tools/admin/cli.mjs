import { provision, migrate } from './database.mjs';
import { createOwner } from './owners.mjs';
import { readAdminInput } from './read-input.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Não aceitar dados administrativos por argumentos');
  if (process.argv[2] === 'migrate') {
    await provision();
    const applied = await migrate();
    console.log(JSON.stringify({ migrationsApplied: applied }));
  } else if (process.argv[2] === 'create-owner') {
    const result = await createOwner(await readAdminInput());
    console.log(JSON.stringify(result));
  } else throw new Error('Comando inválido');
} catch (error) {
  console.error(JSON.stringify({ administration: 'failed', code: /^[A-Z0-9]{5}$/.test(error.code ?? '') ? error.code : 'LOCAL_ERROR' }));
  process.exitCode = 1;
}
