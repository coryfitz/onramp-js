const readline = require('readline/promises');

async function promptYesNo(question, options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  if (!input.isTTY) {
    return false;
  }

  const prompt = readline.createInterface({ input, output });
  try {
    const answer = await prompt.question(question);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    prompt.close();
  }
}

module.exports = { promptYesNo };
