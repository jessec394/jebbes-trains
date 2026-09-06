class WaypointManager {
  constructor() {
    this.Waypoints = [];
    this.SelectedIndex = null;
  }

  UpdateList() {
    const List = document.getElementById('WaypointList');
    List.innerHTML = '';
    for (let i = 0; i < this.Waypoints.length; i++) {
      const Li = document.createElement('li');
      Li.textContent = `${i+1}. (${this.Waypoints[i].lat.toFixed(6)}, ${this.Waypoints[i].lon.toFixed(6)})`;
      Li.onclick = () => this.SelectWaypoint(i);
      Li.ondblclick = () => this.EditWaypoint(i);
      if (i === this.SelectedIndex) {
        Li.classList.add('Selected');
      }
      List.appendChild(Li);
    }
  }

  SelectWaypoint(Index) {
    this.SelectedIndex = Index;
    this.UpdateList();
  }

  AddWaypoint(Lon, Lat, InsertIndex = null) {
    if (InsertIndex === null) {
      InsertIndex = this.SelectedIndex !== null ? this.SelectedIndex + 1 : this.Waypoints.length;
    }
    this.Waypoints.splice(InsertIndex, 0, {lat: Lat, lon: Lon});
    this.SelectedIndex = InsertIndex;
    this.UpdateList();
    return InsertIndex;
  }

  UpdateWaypoint(Index, Lon, Lat) {
    if (Index >= 0 && Index < this.Waypoints.length) {
      this.Waypoints[Index] = {lat: Lat, lon: Lon};
    }
  }

  MoveUp() {
    if (this.SelectedIndex !== null && this.SelectedIndex > 0) {
      const Temp = this.Waypoints[this.SelectedIndex];
      this.Waypoints[this.SelectedIndex] = this.Waypoints[this.SelectedIndex - 1];
      this.Waypoints[this.SelectedIndex - 1] = Temp;
      this.SelectedIndex--;
      this.UpdateList();
    }
  }

  MoveDown() {
    if (this.SelectedIndex !== null && this.SelectedIndex < this.Waypoints.length - 1) {
      const Temp = this.Waypoints[this.SelectedIndex];
      this.Waypoints[this.SelectedIndex] = this.Waypoints[this.SelectedIndex + 1];
      this.Waypoints[this.SelectedIndex + 1] = Temp;
      this.SelectedIndex++;
      this.UpdateList();
    }
  }

  Remove() {
    if (this.SelectedIndex !== null) {
      this.Waypoints.splice(this.SelectedIndex, 1);
      this.SelectedIndex = null;
      this.UpdateList();
    }
  }

  EditWaypoint(Index) {
    this.SelectedIndex = Index;
    const Waypoint = this.Waypoints[Index];
    const Input = document.getElementById('EditInput');
    Input.value = `${Waypoint.lat.toFixed(6)}, ${Waypoint.lon.toFixed(6)}`;
    document.getElementById('EditModal').classList.add('Active');
    Input.focus();
    Input.select();
  }

  SaveEdit() {
    const Input = document.getElementById('EditInput');
    try {
      const Parts = Input.value.replace(/[()]/g, '').split(',').map(p => parseFloat(p.trim()));
      if (Parts.length === 2 && !isNaN(Parts[0]) && !isNaN(Parts[1])) {
        this.Waypoints[this.SelectedIndex] = {lat: Parts[0], lon: Parts[1]};
        this.UpdateList();
        document.getElementById('EditModal').classList.remove('Active');
      } else {
        alert('Invalid format. Use: lat, lon');
      }
    } catch (e) {
      alert('Invalid format. Use: lat, lon');
    }
  }

  Clear() {
    this.Waypoints = [];
    this.SelectedIndex = null;
    this.UpdateList();
  }

  Load(File, OnSuccess) {
    const Reader = new FileReader();
    Reader.onload = (E) => {
      try {
        const Data = JSON.parse(E.target.result);
        if (Data.waypoints && Array.isArray(Data.waypoints)) {
          this.Waypoints = Data.waypoints;
          this.SelectedIndex = null;
          this.UpdateList();
          if (OnSuccess) OnSuccess();
        } else {
          alert('Invalid waypoint file format');
        }
      } catch (err) {
        alert('Failed to load waypoints: Invalid JSON format');
      }
    };
    Reader.onerror = () => {
      alert('Failed to read file');
    };
    Reader.readAsText(File);
  }
}