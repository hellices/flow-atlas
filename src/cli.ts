#!/usr/bin/env node
import { main } from "./commands.js";

process.exitCode = main(process.argv.slice(2));
