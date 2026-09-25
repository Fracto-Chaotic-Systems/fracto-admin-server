import express from 'express'
import chalk from "chalk";
const FRACTO_ADMIN_PORT = Number(process.env.FRACTO_ADMIN_PORT || 3005);

import {handle_main_status} from "./handlers/status.js";
import {handle_logs} from "./handlers/logs.js";
import {handle_version} from "./handlers/versions.js";
import {handle_commits} from "./handlers/commits.js";
import {handle_social} from "./handlers/social.js";
import {handle_ports} from "./handlers/ports.js";
import {handle_login_events, handle_user_update, handle_users} from "./handlers/users.js";

const app = express();

app.use((req, res, next) => {
   res.setHeader('Access-Control-Allow-Origin', '*'); // Allow all origins
   res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS'); // Specify allowed methods
   res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With'); // Specify allowed headers
   next();
});

app.use(express.json());

// Start the server and listen for incoming requests
app.listen(FRACTO_ADMIN_PORT, () => {
   console.log(chalk.green(`fracto-admin-server is running on http://localhost:${FRACTO_ADMIN_PORT}`));
});

app.get('/', handle_main_status)
app.get('/logs', handle_logs)
app.get('/version', handle_version)
app.get('/commits', handle_commits)
app.get('/social', handle_social)
app.get('/ports', handle_ports)
app.get('/users', handle_users)
app.get('/login_events', handle_login_events)
app.put('/users/:id', express.json(), handle_user_update)
