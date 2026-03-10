#!/usr/bin/env node
// Helper script to generate bcrypt hashes for .env file
// Usage: node scripts/hash-passwords.js

const bcrypt = require('bcryptjs');
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('=== Password Hash Generator ===');
console.log('Enter passwords to generate bcrypt hashes for your .env file.\n');

const users = ['admin', 'agent1', 'agent2', 'agent3', 'agent4', 'agent5'];
let index = 0;

function askNext() {
  if (index >= users.length) {
    console.log('\nDone! Copy the lines above into your .env file.');
    rl.close();
    return;
  }
  const user = users[index];
  rl.question(`Password for ${user} (or Enter to skip): `, (password) => {
    if (password.trim()) {
      const hash = bcrypt.hashSync(password.trim(), 10);
      const envKey = user === 'admin' ? 'USER_ADMIN_HASH' : `USER_${user.toUpperCase()}_HASH`;
      console.log(`${envKey}=${hash}`);
    }
    index++;
    askNext();
  });
}

askNext();
