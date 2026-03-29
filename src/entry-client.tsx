import { StartClient } from "@tanstack/react-start/client";
import { createRoot } from "react-dom/client";
import { getRouter } from "./router";

const router = getRouter();

createRoot(document).render(<StartClient router={router} />);
