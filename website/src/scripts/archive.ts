import type { Object3D } from "three";

document.querySelectorAll<HTMLElement>("[data-archive]").forEach((element) => {
  const button = element.querySelector<HTMLButtonElement>(".archive-control")!;
  const container = element.querySelector<HTMLElement>(".archive-canvas")!;
  const status = element.querySelector<HTMLElement>(".archive-status")!;
  const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let toggle: (() => void) | undefined;
  let step = 0;
  let selectedPart = "";
  let ready = false;
  let active = false;
  let loading = false;
  let inView = true;
  let dispose: (() => void) | undefined;

  async function initialize() {
    if (loading) return;
    loading = true;
    button.disabled = true;
    button.textContent = "Opening the archive…";
    let cleanupOnFailure: (() => void) | undefined;
    try {
      const [THREE, { GLTFLoader }, { RoomEnvironment }, { OrbitControls }] = await Promise.all([
        import("three"),
        import("three/addons/loaders/GLTFLoader.js"),
        import("three/addons/environments/RoomEnvironment.js"),
        import("three/addons/controls/OrbitControls.js"),
      ]);
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
      cleanupOnFailure = () => renderer.dispose();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.35;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFShadowMap;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      const environment = pmrem.fromScene(room, 0.04);
      scene.environment = environment.texture;
      scene.environmentIntensity = 0.8;
      room.dispose();
      pmrem.dispose();
      cleanupOnFailure = () => { environment.dispose(); renderer.dispose(); };
      scene.add(new THREE.HemisphereLight(0xfff8eb, 0x71654d, 2));
      const key = new THREE.DirectionalLight(0xffefd2, 4);
      key.position.set(3, 7, 5);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      key.shadow.camera.left = -4;
      key.shadow.camera.right = 4;
      key.shadow.camera.top = 4;
      key.shadow.camera.bottom = -4;
      key.shadow.normalBias = 0.025;
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xf3f5ff, 2);
      fill.position.set(-4, 3, -2);
      scene.add(fill);
      const gltf = await new GLTFLoader().loadAsync("/models/archive.glb");
      const sculpture = gltf.scene;
      const bounds = new THREE.Box3().setFromObject(sculpture);
      const center = bounds.getCenter(new THREE.Vector3());
      const size = bounds.getSize(new THREE.Vector3());
      sculpture.position.sub(center);
      const pivot = new THREE.Group();
      pivot.add(sculpture);
      scene.add(pivot);
      const paper: { object: Object3D; y: number }[] = [];
      const memories: InstanceType<typeof THREE.MeshStandardMaterial>[] = [];
      const frameMaterials: InstanceType<typeof THREE.MeshStandardMaterial>[] = [];
      sculpture.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        object.castShadow = true;
        object.receiveShadow = true;
        if (object.name.startsWith("page_")) paper.push({ object, y: object.position.y });
        if ((object.name.startsWith("ring_") || object.name.startsWith("base_")) && object.material instanceof THREE.MeshStandardMaterial) {
          object.material = object.material.clone();
          object.material.emissive.set(0x9b783c);
          frameMaterials.push(object.material);
        }
        if (object.name.startsWith("memory_") && !object.name.startsWith("memory_cap")) {
          const material = object.material;
          if (material instanceof THREE.MeshStandardMaterial) {
            object.material = material.clone();
            object.material.emissive.set(0xb75710);
            memories.push(object.material);
          }
        }
      });
      const shadow = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.ShadowMaterial({ opacity: 0.15 }));
      shadow.rotation.x = -Math.PI / 2;
      shadow.position.y = -size.y / 2 + 0.005;
      shadow.receiveShadow = true;
      scene.add(shadow);
      const distance = Math.max(size.y, size.x) * 1.85;
      camera.position.set(distance * 0.34, distance * 0.22, distance * 0.88);
      camera.lookAt(0, 0, 0);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableZoom = false;
      controls.enablePan = false;
      controls.enableDamping = !motion.matches;
      controls.dampingFactor = 0.08;
      controls.minPolarAngle = Math.PI / 3;
      controls.maxPolarAngle = Math.PI / 1.8;
      controls.minAzimuthAngle = -Math.PI / 3;
      controls.maxAzimuthAngle = Math.PI / 3;
      controls.target.set(0, 0, 0);
      const resize = () => {
        const { width, height } = container.getBoundingClientRect();
        renderer.setSize(width, height);
        camera.aspect = width / Math.max(1, height);
        camera.updateProjectionMatrix();
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      const intersection = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; });
      intersection.observe(element);
      container.append(renderer.domElement);
      resize();
      let frame = 0;
      let previousTime = 0;
      let elapsed = 0;
      const render = (time: number) => {
        frame = requestAnimationFrame(render);
        if (!active || !inView || document.hidden) { previousTime = time; return; }
        const delta = Math.min((time - previousTime) / 1000, 0.05);
        previousTime = time;
        elapsed += delta;
        const blend = motion.matches ? 1 : 1 - Math.exp(-delta * 5);
        pivot.rotation.y = motion.matches ? 0 : Math.sin(elapsed * 0.22) * 0.035;
        for (const { object, y } of paper) {
          const spread = selectedPart === "pages" ? 1.13 : element.dataset.guide === "true" && step === 0 ? 1.07 : 1;
          object.position.y += (center.y + (y - center.y) * spread - object.position.y) * blend;
        }
        memories.forEach((material, index) => {
          const target = selectedPart === "memories" || step === 2 ? 0.65 + (motion.matches ? 0 : Math.sin(elapsed * 1.5 + index) * 0.12) : step === 1 ? 0.2 : 0.07;
          material.emissiveIntensity += (target - material.emissiveIntensity) * blend;
        });
        frameMaterials.forEach((material) => { material.emissiveIntensity += ((selectedPart === "store" ? 0.45 : 0) - material.emissiveIntensity) * blend; });
        controls.update();
        renderer.render(scene, camera);
      };
      toggle = () => {
        active = !active;
        ready = true;
        element.classList.toggle("is-live", active);
        button.setAttribute("aria-pressed", String(active));
        button.textContent = active ? "Return to still image" : "Explore in 3D ↗";
        status.textContent = active ? "3D archive ready. Drag the sculpture to look around." : "Still image restored.";
        if (active) renderer.render(scene, camera);
      };
      dispose = () => {
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        intersection.disconnect();
        controls.dispose();
        scene.traverse((object) => {
          if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            const materials = Array.isArray(object.material) ? object.material : [object.material];
            materials.forEach((material) => material.dispose());
          }
        });
        key.shadow.map?.dispose();
        environment.dispose();
        renderer.dispose();
      };
      cleanupOnFailure = dispose;
      renderer.domElement.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        active = false;
        element.classList.remove("is-live");
        button.hidden = true;
        status.textContent = "The 3D view is unavailable. The still illustration is shown instead.";
        dispose?.();
      });
      render(0);
      toggle();
    } catch {
      cleanupOnFailure?.();
      container.replaceChildren();
      status.textContent = "The 3D view couldn’t load. You can still read every guide and use the illustrated walkthrough.";
      button.textContent = "Try 3D again";
    } finally {
      loading = false;
      button.disabled = false;
    }
  }
  button.addEventListener("click", () => { if (ready) toggle?.(); else void initialize(); });
  const descriptions: Record<string, string> = {
    pages: "The paper layers represent your sessions. Lore derives useful context from your work; it doesn’t put the whole transcript into every prompt.",
    memories: "The amber pieces represent useful preferences, decisions, and reminders. In Pi, lore_save keeps an explicit note and lore_recall finds it again.",
    store: "The bronze frame represents the local store: ~/.config/lore/lore.db. Pi and Copilot can share it. The sculpture is a metaphor, not a diagram of database tables.",
  };
  element.querySelectorAll<HTMLButtonElement>("[data-archive-part]").forEach((partButton) => {
    partButton.addEventListener("click", () => {
      selectedPart = partButton.dataset.archivePart!;
      element.querySelectorAll<HTMLButtonElement>("[data-archive-part]").forEach((part) => part.setAttribute("aria-pressed", String(part === partButton)));
      element.querySelector<HTMLElement>(".archive-part-description")!.textContent = descriptions[selectedPart];
      if (!ready) void initialize();
      else if (!active) toggle?.();
    });
  });
  element.closest(".memory-journey")?.addEventListener("memory-step", (event) => {
    step = (event as CustomEvent<number>).detail;
    if (!ready) void initialize();
  });
  window.addEventListener("pagehide", (event) => { if (!event.persisted) dispose?.(); });
});
