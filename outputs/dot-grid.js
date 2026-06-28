/** @schema 2.11 */
const dots = [];
const sp = 24;
for (let y = sp; y < pencil.height; y += sp) {
  for (let x = sp; x < pencil.width; x += sp) {
    dots.push({ type: "ellipse", name: "dot", x: x - 1.1, y: y - 1.1, width: 2.2, height: 2.2, fill: "#E2D5C0" });
  }
}
return dots;
