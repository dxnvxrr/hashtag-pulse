using System; using System.Linq; using OneMoreTap.Core;
// Plays a scripted run through RunSession and prints the submission payload + client verdicts as JSON.
// Backend/test/csharpParity.test.ts compiles this with mcs and checks the server re-scores it identically.
static class RunSessionParity { static void Main() {
  var s = new RunSession(424242u, 2000, true, 500, 3, 3);
  int[] offsetsMs = { 30, 3, -12, 7, 99, 99, 99, 1, -1, 14 }; // ring0 ftue window 60
  for (int step = 0; step < offsetsMs.Length; step++) {
    if (step == 2) s.ToggleSlowMo(s.Current.SpawnUs - 1);
    var ring = s.Current; RingResult r;
    if (offsetsMs[step] == 99) { s.Advance(ring.DeadlineUs + 1, out r); }
    else { s.Tap(ring.CloseUs + offsetsMs[step] * 1000L, out r); }
    if (s.AwaitingContinue) s.Continue(ring.DeadlineUs + 4_000_000);
  }
  s.End();
  var v = Enumerable.Range(0, s.RingsResolved).Select(i => "\"" + s.VerdictAt(i).ToString().ToUpperInvariant() + "\"");
  Console.WriteLine("{\"tapsUs\":[" + string.Join(",", s.CopyTaps()) + "],\"slowMoRings\":[" + string.Join(",", s.CopySlowMoRings()) +
    "],\"resumes\":[" + string.Join(",", s.CopyResumes().Select(x => "{\"afterRing\":" + x.afterRing + ",\"atUs\":" + x.atUs + "}")) +
    "],\"verdicts\":[" + string.Join(",", v) + "]}");
}}
