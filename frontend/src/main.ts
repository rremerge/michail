type Appointment = {
  id: string;
  title: string;
  appointmentAt: string;
  notes?: string;
};

const statusEl = document.querySelector<HTMLParagraphElement>("#status");
const listEl = document.querySelector<HTMLUListElement>("#appointments");

const API_BASE_URL =
  (window as Window & { __API_BASE_URL__?: string }).__API_BASE_URL__ ?? "http://localhost:3000";

async function loadAppointments(): Promise<void> {
  if (!statusEl || !listEl) {
    return;
  }

  const userId = "user@example.com";
  const response = await fetch(`${API_BASE_URL}/calendar?userId=${encodeURIComponent(userId)}`);

  if (!response.ok) {
    statusEl.textContent = `Failed to load calendar (${response.status})`;
    return;
  }

  const payload = (await response.json()) as { appointments: Appointment[] };

  if (payload.appointments.length === 0) {
    statusEl.textContent = "No appointments yet.";
    return;
  }

  statusEl.textContent = `Found ${payload.appointments.length} appointment(s).`;

  for (const appointment of payload.appointments) {
    const item = document.createElement("li");
    item.textContent = `${appointment.appointmentAt} - ${appointment.title}`;
    listEl.appendChild(item);
  }
}

void loadAppointments();
