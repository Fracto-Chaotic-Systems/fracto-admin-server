import {process_logfile} from "../../utils/logging.js";

export const handle_logs = (req, res) => {
   process_logfile('admin', res)
}
