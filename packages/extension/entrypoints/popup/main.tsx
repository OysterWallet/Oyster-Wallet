import { createRoot } from "react-dom/client";
import { App } from "../../src/ui/App";
import "../../src/ui/theme.css";

createRoot(document.getElementById("root")!).render(<App />);
