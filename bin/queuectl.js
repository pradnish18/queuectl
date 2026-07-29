#!/usr/bin/env node

const { Command } = require("commander");
const program = new Command();

program.name("queuectl").description("Multi-process background job queue CLI").version("0.1.0");

require("../src/commands/enqueue").register(program);
require("../src/commands/worker").register(program);
require("../src/commands/status").register(program);
require("../src/commands/list").register(program);
require("../src/commands/dlq").register(program);
require("../src/commands/config").register(program);

program.parse();
