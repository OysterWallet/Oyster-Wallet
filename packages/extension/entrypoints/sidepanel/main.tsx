import { createRoot } from "react-dom/client";
import { App } from "../../src/ui/App";
import "../../src/ui/theme.css";

// Same wallet, in the panel down the side of the window. The only difference
// is the frame: the screen fills the panel instead of a fixed popup box.
createRoot(document.getElementById("root")!).render(<App />);
