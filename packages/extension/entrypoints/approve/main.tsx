import { createRoot } from "react-dom/client";
import { ApproveApp } from "../../src/ui/screens/approve";
import "../../src/ui/theme.css";

// Follow the user's chosen theme here too.
import { call } from "../../src/ui/rpc";
void call({ type: "state" }).then((s) => {
  if (s.theme !== "system") document.documentElement.dataset.theme = s.theme;
});

createRoot(document.getElementById("root")!).render(<ApproveApp />);
